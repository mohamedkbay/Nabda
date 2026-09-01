package com.nabda.agent;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Encrypts the server URL, device token, and any pending acknowledgement with Android Keystore. */
public final class SecureSettings {
    private static final String STORE_NAME = "nabda_secure_agent";
    private static final String KEY_ALIAS = "nabda_agent_settings_v1";
    private static final String CREDENTIALS_KEY = "credentials";
    private static final String PENDING_DISPATCH_KEY = "pending_dispatch";
    private static final String PENDING_EVENT_KEY = "pending_event";

    private final SharedPreferences preferences;

    public SecureSettings(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE);
    }

    public synchronized void saveCredentials(String serverUrl, String deviceToken) throws Exception {
        JSONObject value = new JSONObject();
        value.put("server_url", serverUrl);
        value.put("device_token", deviceToken);
        preferences.edit().putString(CREDENTIALS_KEY, encrypt(value.toString())).apply();
    }

    public synchronized Credentials loadCredentials() {
        String encrypted = preferences.getString(CREDENTIALS_KEY, null);
        if (encrypted == null) {
            return Credentials.empty();
        }
        try {
            JSONObject value = new JSONObject(decrypt(encrypted));
            return new Credentials(value.optString("server_url"), value.optString("device_token"));
        } catch (Exception ignored) {
            return Credentials.empty();
        }
    }

    @SuppressLint("ApplySharedPref") // Ordering is safety-critical: persist before clearing dispatch state.
    public synchronized void savePendingEvent(JSONObject event) throws Exception {
        preferences.edit().putString(PENDING_EVENT_KEY, encrypt(event.toString())).commit();
    }

    @SuppressLint("ApplySharedPref") // Dispatch cannot begin until this durable write completes.
    public synchronized void savePendingDispatch(JSONObject dispatch) throws Exception {
        preferences.edit().putString(PENDING_DISPATCH_KEY, encrypt(dispatch.toString())).commit();
    }

    public synchronized JSONObject loadPendingDispatch() {
        return loadEncryptedObject(PENDING_DISPATCH_KEY);
    }

    @SuppressLint("ApplySharedPref")
    public synchronized void clearPendingDispatch() {
        preferences.edit().remove(PENDING_DISPATCH_KEY).commit();
    }

    public synchronized JSONObject loadPendingEvent() {
        return loadEncryptedObject(PENDING_EVENT_KEY);
    }

    private JSONObject loadEncryptedObject(String key) {
        String encrypted = preferences.getString(key, null);
        if (encrypted == null) {
            return null;
        }
        try {
            return new JSONObject(decrypt(encrypted));
        } catch (Exception ignored) {
            return null;
        }
    }

    @SuppressLint("ApplySharedPref")
    public synchronized void clearPendingEvent() {
        preferences.edit().remove(PENDING_EVENT_KEY).commit();
    }

    private String encrypt(String plaintext) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                + "."
                + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private String decrypt(String encoded) throws Exception {
        String[] parts = encoded.split("\\.", 2);
        if (parts.length != 2) {
            throw new JSONException("Invalid encrypted settings");
        }
        byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        KeyStore.Entry existing = store.getEntry(KEY_ALIAS, null);
        if (existing instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existing).getSecretKey();
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    public static final class Credentials {
        public final String serverUrl;
        public final String deviceToken;

        Credentials(String serverUrl, String deviceToken) {
            this.serverUrl = serverUrl == null ? "" : serverUrl;
            this.deviceToken = deviceToken == null ? "" : deviceToken;
        }

        static Credentials empty() {
            return new Credentials("", "");
        }

        public boolean isComplete() {
            return !serverUrl.isEmpty() && !deviceToken.isEmpty();
        }
    }
}
