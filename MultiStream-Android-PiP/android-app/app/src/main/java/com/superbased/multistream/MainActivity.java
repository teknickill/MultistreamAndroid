package com.superbased.multistream;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.util.Rational;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * MultiStream for Android: the MultiStream website in a WebView, plus
 * picture-in-picture.
 *
 * - Press Home (or the PiP button in the app) while a stream is playing and the
 *   app shrinks to a floating window showing the stream you're listening to.
 *   On Android 12+ this happens by itself; on 8-11 it happens from onUserLeaveHint.
 * - The page knows it's in PiP (window.MultiStreamApp.setPip) and shows just
 *   that one stream, edge to edge.
 * - Links that leave the site (Open on YouTube, pop-out chat) open in the
 *   browser / YouTube app instead of replacing the page.
 * - YouTube sign-in for the chats (window.MultiStreamAndroid.signIn / signOut).
 * - Native YouTube panels (panelOpen / panelPlace / panelClose): the page marks
 *   a spot and the app draws a real YouTube page there (used for live chats,
 *   so they're first-party: every option, the app's own login).
 * - Search and @handle lookups run on the phone itself (ytFetch): the app
 *   downloads the youtube.com page and the web page reads it. No server, no
 *   API key, and each phone uses its own connection.
 *   The app keeps its own login; it's saved to disk so it survives restarts.
 *
 * Playback with the app fully hidden (no PiP window) is left to YouTube's
 * player, which normally pauses then; this app doesn't try to work around that.
 */
public class MainActivity extends Activity {

    private static final int BG = 0xFF0B0C0F;
    private static final long POLL_MS = 3000;

    private FrameLayout root;
    private WebView web;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private boolean inPip = false;
    private boolean pageHasStream = false;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private String siteHost;
    private LinearLayout signInLayer;   // full-screen Google sign-in page, when open
    private WebView signInWeb;
    private boolean signInDone = false;
    // Native YouTube panels, drawn over the page where it asks (chats).
    private FrameLayout panelLayer;
    private final Map<String, Panel> panels = new HashMap<String, Panel>();

    /** One panel: a clipping box at the visible part, the full-size page inside it. */
    private static class Panel {
        FrameLayout clip;
        WebView view;
        String url;
        int cw = -1, ch = -1, fw = -1, fh = -1;
    }

    // Recent errors from the YouTube pages the app shows (chats), for "Copy chat debug info".
    private final ArrayDeque<String> debugLog = new ArrayDeque<String>();
    private String webUa = "";

    private void addDebug(String line) {
        synchronized (debugLog) {
            String t = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(new java.util.Date());
            debugLog.addLast(t + " " + (line.length() > 300 ? line.substring(0, 300) + "…" : line));
            while (debugLog.size() > 80) debugLog.removeFirst();
        }
    }

    private static String shortUrl(String u) {
        if (u == null) return "";
        int q = u.indexOf('?');
        return q > 0 ? u.substring(0, q) : u;    // no query strings (they can hold tokens)
    }

    /** Page client for the app's YouTube pages: records failures for the debug info. */
    private class LoggingClient extends WebViewClient {
        final String tag;
        LoggingClient(String tag) { this.tag = tag; }

        @Override
        public void onReceivedHttpError(WebView v, WebResourceRequest req, WebResourceResponse res) {
            addDebug(tag + " http " + res.getStatusCode() + " " + req.getMethod() + " " + shortUrl(req.getUrl().toString()));
        }

        @Override
        public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
            addDebug(tag + " net " + err.getDescription() + " " + shortUrl(req.getUrl().toString()));
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            addDebug(tag + " loaded " + shortUrl(url) + " signedIn=" + isSignedIn());
        }
    }

    /** Pop-ups, dialogs and console messages for the app's YouTube pages. */
    private WebChromeClient youtubeChrome(final String tag) {
        return new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                ConsoleMessage.MessageLevel lv = m.messageLevel();
                if (lv == ConsoleMessage.MessageLevel.ERROR || lv == ConsoleMessage.MessageLevel.WARNING) {
                    addDebug(tag + " console " + lv + ": " + m.message() + " @" + shortUrl(m.sourceId()) + ":" + m.lineNumber());
                }
                return false;
            }

            // A page opening a new window: YouTube pages full screen in the app, others in the browser.
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                addDebug(tag + " window.open");
                final WebView catcher = new WebView(MainActivity.this);
                catcher.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                        String u = req.getUrl().toString();
                        if (isYouTubePage(u)) {
                            if (signInLayer != null && signInWeb != null) signInWeb.loadUrl(u);
                            else showOverlay(u, false);
                        } else {
                            openOutside(req.getUrl());
                        }
                        catcher.destroy();
                        return true;
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(catcher);
                resultMsg.sendToTarget();
                return true;
            }
        };
    }

    private String debugInfo() {
        StringBuilder b = new StringBuilder();
        b.append("MultiStream app debug\n");
        b.append("Android SDK ").append(Build.VERSION.SDK_INT).append("\n");
        b.append("WebView UA: ").append(webUa).append("\n");
        b.append("Signed in: ").append(isSignedIn()).append("\n");
        ArrayList<String> urls = new ArrayList<String>();
        try { for (Panel p : panels.values()) urls.add(shortUrl(p.url)); } catch (RuntimeException ignored) { /* changing */ }
        b.append("Chats open: ").append(urls.size()).append("\n");
        for (String u : urls) b.append("  ").append(u).append("\n");
        b.append("Recent:\n");
        synchronized (debugLog) { for (String l : debugLog) b.append(l).append("\n"); }
        return b.toString();
    }

    private boolean overlayIsSignIn = true;     // sign-in page (closes itself) or a YouTube page (chat)
    private boolean overlayStartedSignedIn = false;

    // ytFetch: downloaded YouTube pages waiting for the web page to take them.
    private final Map<String, String> fetched = new ConcurrentHashMap<String, String>();
    private final ExecutorService net = Executors.newFixedThreadPool(3);
    private static final int MAX_PAGE_BYTES = 6 * 1024 * 1024;
    private static final String PAGE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

    private static final String YT = "https://www.youtube.com";
    private static final String SIGN_IN_URL = "https://accounts.google.com/ServiceLogin?service=youtube"
            + "&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3D%252F";

    // ------------------------------------------------------------------ setup
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        siteHost = Uri.parse(BuildConfig.SITE_URL).getHost();

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        web = new WebView(this);
        web.setBackgroundColor(BG);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // Above the page, below sign-in/full chat. Empty areas pass touches through.
        panelLayer = new FrameLayout(this);
        root.addView(panelLayer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        keepClearOfSystemBars();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                  // remembers your streams
        s.setMediaPlaybackRequiresUserGesture(false);  // streams start on their own
        s.setSupportMultipleWindows(true);             // window.open -> onCreateWindow below
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setUserAgentString(s.getUserAgentString() + " MultiStreamAndroid/1.0");
        webUa = s.getUserAgentString();
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);  // YouTube chat sign-in

        web.addJavascriptInterface(new Bridge(), "MultiStreamAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (!req.isForMainFrame()) return false;           // players and chats load normally
                Uri u = req.getUrl();
                if (siteHost != null && siteHost.equalsIgnoreCase(u.getHost())) return false;
                // YouTube's own "Sign in" (e.g. inside a chat): sign in to THIS app,
                // not the phone's browser, or the chats never see the login.
                if (isSignInLink(u)) { showSignIn(); return true; }
                openOutside(u);
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // A YouTube player's own full-screen button.
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) { callback.onCustomViewHidden(); return; }
                fullscreenView = view;
                fullscreenCallback = callback;
                view.setBackgroundColor(0xFF000000);
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
                panelLayer.bringToFront();          // a full-screen stream keeps its chat
                if (signInLayer != null) signInLayer.bringToFront();
                setSystemBarsHidden(true);
            }

            @Override
            public void onHideCustomView() {
                if (fullscreenView == null) return;
                root.removeView(fullscreenView);
                fullscreenView = null;
                web.setVisibility(View.VISIBLE);
                setSystemBarsHidden(false);
                if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
                fullscreenCallback = null;
            }

            // window.open (Open on YouTube, pop-out chat): catch the URL, open it outside.
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                final WebView catcher = new WebView(MainActivity.this);
                catcher.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                        if (isSignInLink(req.getUrl())) showSignIn();
                        else openOutside(req.getUrl());
                        catcher.destroy();
                        return true;
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(catcher);
                resultMsg.sendToTarget();
                return true;
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(BuildConfig.SITE_URL);
    }

    /** Google / YouTube sign-in pages. */
    private static boolean isSignInLink(Uri u) {
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase();
        String path = u.getPath() == null ? "" : u.getPath();
        if (!scheme.equals("https") && !scheme.equals("http")) return false;
        if (host.equals("accounts.google.com") || host.equals("accounts.youtube.com")) return true;
        boolean yt = host.equals("youtube.com") || host.endsWith(".youtube.com");
        return yt && (path.startsWith("/signin") || path.startsWith("/ServiceLogin") || path.startsWith("/logout"));
    }

    private void openOutside(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException ignored) {
            // nothing can open it
        }
    }

    // ------------------------------------------------------- YouTube sign-in
    // Google's sign-in page, full screen over the app, with a Done button.
    // Closes by itself once Google sends you back to YouTube.
    private void showSignIn() { showOverlay(SIGN_IN_URL, true); }

    // A YouTube page full screen over the app (the pop-out chat): it's a real
    // YouTube page, not a frame inside ours, so every chat option works, with
    // the app's own login. Done / Back closes it; Browser opens it outside.
    private void showOverlay(String url, boolean isSignIn) { showOverlay(url, isSignIn, false); }

    // Browse: YouTube's own mobile site (home feed, subscriptions, search) with
    // the app's login, plus "+ Add to MultiStream" for the video/channel on screen.
    private void showBrowse() { showOverlay("https://m.youtube.com/", false, true); }

    /** Text safe inside a single-quoted JavaScript string. */
    private static String jsString(String v) {
        StringBuilder b = new StringBuilder("'");
        for (char c : v.toCharArray()) {
            if (c == '\\' || c == '\'') b.append('\\').append(c);
            else if (c < 0x20 || c == 0x2028 || c == 0x2029 || c == '<') b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append("'").toString();
    }

    private void showOverlay(String url, boolean isSignIn, boolean browse) {
        if (signInLayer != null) return;
        signInDone = false;
        overlayIsSignIn = isSignIn;
        overlayStartedSignedIn = isSignedIn();
        signInLayer = new LinearLayout(this);
        signInLayer.setOrientation(LinearLayout.VERTICAL);
        signInLayer.setBackgroundColor(BG);
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        Button done = new Button(this);
        done.setText("Done");
        done.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) { closeSignIn(); }
        });
        bar.addView(done, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        if (browse) {
            Button add = new Button(this);
            add.setText("+ Add to MultiStream");
            add.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    String now = signInWeb != null ? signInWeb.getUrl() : null;
                    if (now == null) return;
                    // The page decides: a video/live/channel page is added; anything else gets a hint.
                    web.evaluateJavascript("window.MultiStreamApp && MultiStreamApp.addFromApp && MultiStreamApp.addFromApp("
                            + jsString(now) + ")", new android.webkit.ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String result) {
                            // "added" / "dupe" close; anything else: say why, stay here.
                            if ("\"added\"".equals(result) || "\"dupe\"".equals(result)) closeSignIn();
                            else if ("\"full\"".equals(result)) Toast.makeText(MainActivity.this,
                                    "Up to 16 streams at once — remove one first.", Toast.LENGTH_SHORT).show();
                            else Toast.makeText(MainActivity.this,
                                    "Open a video, live stream or channel first, then tap Add.", Toast.LENGTH_SHORT).show();
                        }
                    });
                }
            });
            bar.addView(add, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 2f));
        } else if (!isSignIn) {
            Button outside = new Button(this);
            outside.setText("Open in browser");
            outside.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    String now = signInWeb != null ? signInWeb.getUrl() : null;
                    if (now != null) openOutside(Uri.parse(now));
                    closeSignIn();
                }
            });
            bar.addView(outside, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        }
        signInWeb = new WebView(this);
        WebSettings s = signInWeb.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(signInWeb, true);
        signInWeb.setWebChromeClient(youtubeChrome(isSignIn ? "signin" : "fullchat"));
        signInWeb.setWebViewClient(new LoggingClient(isSignIn ? "signin" : "fullchat") {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                // App links (intent://, vnd.youtube://) would leave the app: ignore them.
                String sc = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
                if (!(sc.equals("https") || sc.equals("http"))) return true;
                if (overlayIsSignIn || !req.isForMainFrame()) return false;
                // Chat page: YouTube / Google pages (incl. sign-in) stay here,
                // links people post in chat open in the browser.
                String h = u.getHost() == null ? "" : u.getHost().toLowerCase();
                if (h.equals("youtube.com") || h.endsWith(".youtube.com") || h.endsWith(".google.com") || h.equals("google.com")) return false;
                openOutside(u);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (!overlayIsSignIn) return;
                Uri u = Uri.parse(url);
                String host = u.getHost() == null ? "" : u.getHost();
                String path = u.getPath() == null ? "" : u.getPath();
                // Back on YouTube (not its /signin hand-off page): signed in.
                if ((host.equals("youtube.com") || host.endsWith(".youtube.com")) && !path.startsWith("/signin")) {
                    closeSignIn();
                }
            }
        });
        signInLayer.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        signInLayer.addView(signInWeb, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(signInLayer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        signInWeb.loadUrl(url);
    }

    private void closeSignIn() {
        if (signInLayer == null || signInDone) return;
        signInDone = true;
        root.removeView(signInLayer);
        final WebView w = signInWeb;
        signInLayer = null;
        signInWeb = null;
        handler.post(new Runnable() {     // not from inside the WebView's own callback
            @Override
            public void run() { w.destroy(); }
        });
        CookieManager.getInstance().flush();
        boolean now = isSignedIn();
        // Reload the chats only when the login actually changed (or after Sign in).
        if (overlayIsSignIn || now != overlayStartedSignedIn) tellPageAccount(now);
    }

    private boolean isSignedIn() {
        String c = CookieManager.getInstance().getCookie(YT);
        return c != null && (c.contains("SAPISID=") || c.contains("LOGIN_INFO="));
    }

    // Signs this app out of YouTube/Google (clears the app's cookies only;
    // your browser and the YouTube app are untouched).
    private void clearYouTubeLogin() {
        CookieManager.getInstance().removeAllCookies(new android.webkit.ValueCallback<Boolean>() {
            @Override
            public void onReceiveValue(Boolean removed) {
                CookieManager.getInstance().flush();
                tellPageAccount(false);
            }
        });
    }

    private void tellPageAccount(boolean signedIn) {
        reloadPanels();
        web.evaluateJavascript("window.MultiStreamApp && MultiStreamApp.accountChanged && MultiStreamApp.accountChanged("
                + signedIn + ")", null);
    }

    // -------------------------------------------------- YouTube page lookups
    // Only https pages on youtube.com: the bridge can't be used to reach
    // anything else.
    private static boolean isYouTubePage(String s) {
        try {
            URL u = new URL(s);
            String h = u.getHost() == null ? "" : u.getHost().toLowerCase();
            return "https".equals(u.getProtocol())
                    && (h.equals("www.youtube.com") || h.equals("youtube.com") || h.equals("m.youtube.com"));
        } catch (Exception e) {
            return false;
        }
    }

    private void downloadPage(final String id, final String url) {
        int status = 0;
        String body;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(12000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", PAGE_UA);
            c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
            // Skips the EU cookie-consent page. Your own YouTube login isn't sent.
            c.setRequestProperty("Cookie", "CONSENT=YES+cb; SOCS=CAI");
            status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (in != null) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) != -1 && out.size() < MAX_PAGE_BYTES) out.write(buf, 0, n);
                in.close();
            }
            body = new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            status = 0;
            body = "Couldn't reach YouTube from this phone.";
        } finally {
            if (c != null) c.disconnect();
        }
        if (fetched.size() > 20) fetched.clear();   // the page never collected them (e.g. reloaded)
        fetched.put(id, body);
        final int st = status;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (isFinishing()) return;
                web.evaluateJavascript("window.MultiStreamApp && MultiStreamApp.ytFetchDone && MultiStreamApp.ytFetchDone('"
                        + id + "'," + st + ")", null);
            }
        });
    }

    // ------------------------------------------------- native YouTube panels
    private void openPanel(String id, String url) {
        Panel p = panels.get(id);
        if (p != null) {
            if (!url.equals(p.url)) { p.url = url; p.view.loadUrl(url); }
            return;
        }
        p = new Panel();
        p.url = url;
        p.clip = new FrameLayout(this);            // clips the page to the visible part
        p.view = new WebView(this);
        p.view.setBackgroundColor(BG);
        WebSettings s = p.view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(p.view, true);
        p.view.setWebChromeClient(youtubeChrome("chat"));
        p.view.getSettings().setSupportMultipleWindows(true);
        p.view.setWebViewClient(new LoggingClient("chat") {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String sc = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
                if (!(sc.equals("https") || sc.equals("http"))) return true;      // app links: ignore
                if (!req.isForMainFrame()) return false;
                if (isSignInLink(u)) { showSignIn(); return true; }             // sign in full screen
                String h = u.getHost() == null ? "" : u.getHost().toLowerCase();
                if (h.equals("youtube.com") || h.endsWith(".youtube.com")) return false;
                openOutside(u);                                                  // links posted in chat
                return true;
            }
        });
        p.clip.addView(p.view, new FrameLayout.LayoutParams(1, 1));
        p.clip.setVisibility(View.GONE);
        panelLayer.addView(p.clip, new FrameLayout.LayoutParams(1, 1));
        panels.put(id, p);
        p.view.loadUrl(url);
    }

    /** "id,show,clipX,clipY,clipW,clipH,pageX,pageY,pageW,pageH;..." in screen pixels. */
    private void placePanels(String msg) {
        Set<String> seen = new HashSet<String>();
        if (msg != null && msg.length() > 0) {
            for (String part : msg.split(";")) {
                String[] f = part.split(",");
                if (f.length != 10) continue;
                Panel p = panels.get(f[0]);
                if (p == null) continue;
                seen.add(f[0]);
                try {
                    boolean show = "1".equals(f[1]);
                    int cx = Integer.parseInt(f[2]), cy = Integer.parseInt(f[3]);
                    int cw = Integer.parseInt(f[4]), ch = Integer.parseInt(f[5]);
                    int ox = Integer.parseInt(f[6]), oy = Integer.parseInt(f[7]);
                    int fw = Integer.parseInt(f[8]), fh = Integer.parseInt(f[9]);
                    if (!show || cw < 2 || ch < 2) { p.clip.setVisibility(View.GONE); continue; }
                    if (cw != p.cw || ch != p.ch) {
                        p.cw = cw; p.ch = ch;
                        p.clip.setLayoutParams(new FrameLayout.LayoutParams(cw, ch));
                    }
                    if (fw != p.fw || fh != p.fh) {           // only resizes when the chat's size changes,
                        p.fw = fw; p.fh = fh;                 // not while scrolling (no re-layout jank)
                        p.view.setLayoutParams(new FrameLayout.LayoutParams(fw, fh));
                    }
                    p.clip.setX(cx);
                    p.clip.setY(cy);
                    p.view.setX(ox);
                    p.view.setY(oy);
                    p.clip.setVisibility(View.VISIBLE);
                } catch (NumberFormatException ignored) {
                    p.clip.setVisibility(View.GONE);
                }
            }
        }
        for (Map.Entry<String, Panel> e : panels.entrySet()) {
            if (!seen.contains(e.getKey())) e.getValue().clip.setVisibility(View.GONE);
        }
    }

    private void closePanel(String id) {
        Panel p = panels.remove(id);
        if (p == null) return;
        panelLayer.removeView(p.clip);
        p.view.destroy();
    }

    private void closeAllPanels() {
        for (String id : new ArrayList<String>(panels.keySet())) closePanel(id);
    }

    private void reloadPanels() {
        for (Panel p : panels.values()) p.view.reload();
    }

    // ------------------------------------------------------------ PiP
    private boolean pipSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    private PictureInPictureParams pipParams() {
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational(16, 9));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+: Home with a stream playing slides straight into PiP.
            b.setAutoEnterEnabled(pageHasStream);
            b.setSeamlessResizeEnabled(false);
        }
        return b.build();
    }

    private void enterPip() {
        if (!pipSupported() || inPip) return;
        try {
            enterPictureInPictureMode(pipParams());
        } catch (IllegalStateException ignored) {
            // the system refused (e.g. PiP turned off for this app in Settings)
        }
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Android 8-11 have no auto-enter: go to PiP when Home is pressed.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && pageHasStream) enterPip();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPip, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPip, newConfig);
        inPip = isInPip;
        panelLayer.setVisibility(isInPip ? View.GONE : View.VISIBLE);   // no chats in the tiny window
        root.requestApplyInsets();
        web.evaluateJavascript("window.MultiStreamApp && MultiStreamApp.setPip(" + isInPip + ")", null);
    }

    // Asks the page every few seconds whether a stream is playing, so Home only
    // goes to PiP when there's something to watch.
    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            web.evaluateJavascript("!!(window.MultiStreamApp && MultiStreamApp.hasStream())",
                    new android.webkit.ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            boolean has = "true".equals(value);
                            if (has != pageHasStream) {
                                pageHasStream = has;
                                if (pipSupported()) setPictureInPictureParams(pipParams());
                            }
                        }
                    });
            handler.postDelayed(this, POLL_MS);
        }
    };

    /** What the web page can call (window.MultiStreamAndroid). */
    private class Bridge {
        @JavascriptInterface
        public boolean pipSupported() {
            return MainActivity.this.pipSupported();
        }

        @JavascriptInterface
        public void enterPip() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    pageHasStream = true;
                    MainActivity.this.enterPip();
                }
            });
        }

        @JavascriptInterface
        public void signIn() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() { showSignIn(); }
            });
        }

        @JavascriptInterface
        public void signOut() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() { clearYouTubeLogin(); }
            });
        }

        @JavascriptInterface
        public boolean signedIn() {
            return isSignedIn();
        }

        /** Downloads a youtube.com page; calls MultiStreamApp.ytFetchDone(id, status) when done. */
        @JavascriptInterface
        public void ytFetch(final String id, final String url) {
            if (id == null || !id.matches("[A-Za-z0-9_-]{1,40}")) return;
            if (url == null || !isYouTubePage(url)) {
                fetched.put(id, "Only YouTube pages can be looked up.");
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        web.evaluateJavascript("window.MultiStreamApp && MultiStreamApp.ytFetchDone('" + id + "',0)", null);
                    }
                });
                return;
            }
            net.execute(new Runnable() {
                @Override
                public void run() { downloadPage(id, url); }
            });
        }

        /** Draw a YouTube page (a chat) natively; the page then sends where. */
        @JavascriptInterface
        public void panelOpen(final String id, final String url) {
            if (id == null || !id.matches("[A-Za-z0-9_-]{1,40}") || url == null || !isYouTubePage(url)) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() { openPanel(id, url); }
            });
        }

        @JavascriptInterface
        public void panelPlace(final String msg) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() { placePanels(msg); }
            });
        }

        @JavascriptInterface
        public void panelClose(final String id) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() { closePanel(id); }
            });
        }

        @JavascriptInterface
        public void panelCloseAll() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() { closeAllPanels(); }
            });
        }

        /** Recent chat errors etc., for the user to copy and send. */
        @JavascriptInterface
        public String debugInfo() {
            return MainActivity.this.debugInfo();
        }

        /** YouTube's own site full screen in the app, with "+ Add to MultiStream". */
        @JavascriptInterface
        public void openBrowse() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() { showBrowse(); }
            });
        }

        /** Opens a YouTube page (the pop-out chat) full screen inside the app. */
        @JavascriptInterface
        public void openChat(final String url) {
            if (url == null || !isYouTubePage(url)) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() { showOverlay(url, false); }
            });
        }

        /** The downloaded text for id (once; frees it). */
        @JavascriptInterface
        public String ytFetchTake(String id) {
            String s = id == null ? null : fetched.remove(id);
            return s == null ? "" : s;
        }
    }

    // ------------------------------------------------------- lifecycle
    @Override
    protected void onStart() {
        super.onStart();
        web.onResume();
        for (Panel p : panels.values()) p.view.onResume();
        handler.removeCallbacks(poll);
        handler.post(poll);
    }

    @Override
    protected void onStop() {
        super.onStop();
        handler.removeCallbacks(poll);
        CookieManager.getInstance().flush();   // keep the YouTube login if Android closes the app
        // Still showing in a PiP window? Keep playing. Otherwise the app is hidden.
        if (!isInPictureInPictureMode()) {
            web.onPause();
            for (Panel p : panels.values()) p.view.onPause();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (signInLayer != null) {
            if (signInWeb.canGoBack()) signInWeb.goBack();
            else closeSignIn();
        } else if (fullscreenView != null) {
            web.getWebChromeClient().onHideCustomView();
        } else if (web.canGoBack()) {
            web.goBack();
        } else {
            moveTaskToBack(true);   // keep the streams loaded instead of closing
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(poll);
        if (signInWeb != null) signInWeb.destroy();
        net.shutdownNow();
        for (Panel p : panels.values()) p.view.destroy();
        panels.clear();
        web.destroy();
        super.onDestroy();
    }

    // --------------------------------------------------------- system bars
    // Android 15 draws apps under the status/navigation bars; pad the page so
    // the top bar isn't hidden behind the clock. No padding in PiP/full screen.
    private void keepClearOfSystemBars() {
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                if (inPip || fullscreenView != null) {
                    v.setPadding(0, 0, 0, 0);
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    // ime(): the keyboard. The page shrinks above it instead of being
                    // covered (Android 15 no longer does this by itself).
                    Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
                            | WindowInsets.Type.ime());
                    v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                } else {
                    v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                            insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                }
                return insets;
            }
        });
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) c.setSystemBarsAppearance(0,
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                            | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);  // light icons on dark
        }
    }

    @SuppressWarnings("deprecation")
    private void setSystemBarsHidden(boolean on) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                if (on) {
                    c.hide(WindowInsets.Type.systemBars());
                    c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                } else {
                    c.show(WindowInsets.Type.systemBars());
                }
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(on
                    ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                      | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    : 0);
        }
        root.requestApplyInsets();
    }
}
