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
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
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
        setContentView(root);
        keepClearOfSystemBars();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                  // remembers your streams
        s.setMediaPlaybackRequiresUserGesture(false);  // streams start on their own
        s.setSupportMultipleWindows(true);             // window.open -> onCreateWindow below
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setUserAgentString(s.getUserAgentString() + " MultiStreamAndroid/1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);  // YouTube chat sign-in

        web.addJavascriptInterface(new Bridge(), "MultiStreamAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (!req.isForMainFrame()) return false;           // players and chats load normally
                Uri u = req.getUrl();
                if (siteHost != null && siteHost.equalsIgnoreCase(u.getHost())) return false;
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
                        openOutside(req.getUrl());
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
    private void showSignIn() {
        if (signInLayer != null) return;
        signInDone = false;
        signInLayer = new LinearLayout(this);
        signInLayer.setOrientation(LinearLayout.VERTICAL);
        signInLayer.setBackgroundColor(BG);
        Button done = new Button(this);
        done.setText("Done");
        done.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) { closeSignIn(); }
        });
        signInWeb = new WebView(this);
        WebSettings s = signInWeb.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(signInWeb, true);
        signInWeb.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return false;   // the whole sign-in flow stays in this page
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Uri u = Uri.parse(url);
                String host = u.getHost() == null ? "" : u.getHost();
                String path = u.getPath() == null ? "" : u.getPath();
                // Back on YouTube (not its /signin hand-off page): signed in.
                if ((host.equals("youtube.com") || host.endsWith(".youtube.com")) && !path.startsWith("/signin")) {
                    closeSignIn();
                }
            }
        });
        signInLayer.addView(done, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        signInLayer.addView(signInWeb, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(signInLayer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        signInWeb.loadUrl(SIGN_IN_URL);
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
        tellPageAccount(isSignedIn());
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
        handler.removeCallbacks(poll);
        handler.post(poll);
    }

    @Override
    protected void onStop() {
        super.onStop();
        handler.removeCallbacks(poll);
        CookieManager.getInstance().flush();   // keep the YouTube login if Android closes the app
        // Still showing in a PiP window? Keep playing. Otherwise the app is hidden.
        if (!isInPictureInPictureMode()) web.onPause();
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
                    Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
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
