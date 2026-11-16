package com.streamingvideo.picker;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashSet;
import java.util.Set;

/** Sélection SAF : le droit lecture survit à la fermeture de l'application. */
public final class SVVideoPicker extends CordovaPlugin {
    private static final int SELECT_VIDEO = 12409;
    private CallbackContext pending;

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callback) {
        if (!"select".equals(action)) return false;
        if (pending != null) { callback.error("Le sélecteur de vidéos est déjà ouvert."); return true; }
        pending = callback;
        Activity activity = cordova.getActivity();
        activity.runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("video/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                cordova.startActivityForResult(this, intent, SELECT_VIDEO);
            } catch (RuntimeException error) {
                CallbackContext reply = pending;
                pending = null;
                if (reply != null) reply.error("Impossible d'ouvrir le sélecteur de vidéos : " + error.getMessage());
            }
        });
        return true;
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent intent) {
        if (requestCode != SELECT_VIDEO || pending == null) return;
        CallbackContext reply = pending;
        pending = null;
        if (resultCode != Activity.RESULT_OK || intent == null) { reply.success(new JSONArray()); return; }
        Set<Uri> selected = new LinkedHashSet<>();
        ClipData clip = intent.getClipData();
        if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) {
            Uri uri = clip.getItemAt(i).getUri();
            if (uri != null) selected.add(uri);
        }
        if (intent.getData() != null) selected.add(intent.getData());
        final int flags = intent.getFlags();
        cordova.getThreadPool().execute(() -> {
            try {
                ContentResolver resolver = cordova.getActivity().getContentResolver();
                JSONArray files = new JSONArray();
                for (Uri uri : selected) {
                    if (!"content".equals(uri.getScheme())) throw new IllegalArgumentException("La vidéo ne fournit pas d'accès durable.");
                    int granted = flags & Intent.FLAG_GRANT_READ_URI_PERMISSION;
                    // Certains fournisseurs ne renvoient pas le bit persistable
                    // dans le résultat. L'appel ci-dessous vérifie réellement le droit.
                    if (granted == 0) throw new SecurityException("L'application de fichiers n'a pas accordé la lecture de cette vidéo.");
                    resolver.takePersistableUriPermission(uri, granted);
                    String name = null;
                    long size = -1;
                    try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                        if (cursor != null && cursor.moveToFirst()) {
                            int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                            int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                            if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex);
                            if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex);
                        }
                    }
                    if (name == null || name.isEmpty() || size <= 0) throw new IllegalArgumentException("Le nom ou la taille d'une vidéo est indisponible.");
                    JSONObject file = new JSONObject();
                    file.put("uri", uri.toString());
                    file.put("name", name);
                    file.put("size", size);
                    String mime = resolver.getType(uri);
                    file.put("type", mime != null ? mime : "application/octet-stream");
                    files.put(file);
                }
                reply.success(files);
            } catch (Exception error) {
                reply.error("Impossible de conserver l'accès à la vidéo : " + (error.getMessage() != null ? error.getMessage() : "erreur du téléphone"));
            }
        });
    }
}
