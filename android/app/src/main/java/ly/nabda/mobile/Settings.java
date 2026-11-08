package ly.nabda.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Only nonsensitive display preferences are stored in plaintext. */
final class Settings {
    private final SharedPreferences prefs;
    Settings(Context c) { prefs = c.getSharedPreferences("nabda", Context.MODE_PRIVATE); }
    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
        if (ks.containsAlias("nabda-device")) return ((KeyStore.SecretKeyEntry) ks.getEntry("nabda-device", null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder("nabda-device", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    synchronized void saveCredentials(String server, String device, String token) throws Exception {
        JSONObject value = new JSONObject().put("server", server).put("device", device).put("token", token);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        String encoded = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        if (!prefs.edit().putString("credentials", encoded).commit()) throw new IllegalStateException("Could not save device credentials.");
    }
    synchronized JSONObject credentials() {
        try {
            String encoded = prefs.getString("credentials", null); if (encoded == null) return null;
            String[] parts = encoded.split("\\.", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
        } catch (Exception error) { return null; }
    }
    static String scope(JSONObject credentials) { return credentials == null ? "" : credentials.optString("server") + "\n" + credentials.optString("device"); }
    int sim() { return prefs.getInt("sim", -1); }
    void sim(int value) { prefs.edit().putInt("sim", value).apply(); }
    int intervalSeconds() { return Math.max(6, prefs.getInt("interval", 12)); }
    void intervalSeconds(int value) { prefs.edit().putInt("interval", Math.max(6, Math.min(3600, value))).apply(); }
    long lastSend() { return prefs.getLong("last-send", 0); }
    void lastSend(long value) { prefs.edit().putLong("last-send", value).commit(); }
    boolean arabic() { return prefs.getBoolean("arabic", false); }
    void arabic(boolean value) { prefs.edit().putBoolean("arabic", value).apply(); }
    String state() { return prefs.getString("state", "Not connected yet."); }
    void state(String value) { prefs.edit().putString("state", value).apply(); }
}
