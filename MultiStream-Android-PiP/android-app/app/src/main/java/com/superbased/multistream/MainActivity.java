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
import android.widget.FrameLayout;

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
                setImmersive(true);
            }

            @Override
            public void onHideCustomView() {
                if (fullscreenView == null) return;
                root.removeView(fullscreenView);
                fullscreenView = null;
                web.setVisibility(View.VISIBLE);
                setImmersive(false);
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
        if (fullscreenView != null) {
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
    private void setImmersive(boolean on) {
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
