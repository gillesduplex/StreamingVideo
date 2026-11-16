package com.streamingvideo.orientation;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;

public final class SVScreenOrientation extends CordovaPlugin {
    private Integer previousOrientation;

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callback) {
        if (!"landscape".equals(action) && !"restore".equals(action)) return false;
        Activity activity = cordova.getActivity();
        activity.runOnUiThread(() -> {
            try {
                if ("landscape".equals(action)) {
                    if (previousOrientation == null) previousOrientation = activity.getRequestedOrientation();
                    activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                } else if (previousOrientation != null) {
                    activity.setRequestedOrientation(previousOrientation);
                    previousOrientation = null;
                }
                callback.success();
            } catch (RuntimeException error) {
                callback.error(error.getMessage() != null ? error.getMessage() : "Orientation indisponible");
            }
        });
        return true;
    }

    private void restoreOnExit() {
        Activity activity = cordova.getActivity();
        activity.runOnUiThread(() -> {
            if (previousOrientation == null) return;
            activity.setRequestedOrientation(previousOrientation);
            previousOrientation = null;
        });
    }

    @Override public void onReset() { restoreOnExit(); }
    @Override public void onDestroy() { restoreOnExit(); }
}
