package ly.nabda.mobile;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;

/** HTTPS only, no redirects, bounded I/O, no token logging. */
final class Api {
    static String normalize(String value) throws Exception {
        return ServerPolicy.normalize(value);
    }
    static JSONObject post(String server, String path, String token, JSONObject body) throws Exception {
        String origin = normalize(server);
        HttpURLConnection connection = (HttpURLConnection) URI.create(origin + path).toURL().openConnection();
        connection.setRequestMethod("POST"); connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(12000); connection.setReadTimeout(15000); connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json"); connection.setRequestProperty("Accept", "application/json");
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(bytes.length);
        try {
            try (java.io.OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new IllegalStateException("The server redirected. Check the site address; credentials were not forwarded.");
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            ByteArrayOutputStream data = new ByteArrayOutputStream();
            if (stream != null) try (InputStream input = stream) {
                byte[] chunk = new byte[4096]; int length;
                while ((length = input.read(chunk)) >= 0) { if (data.size() + length > 1024 * 1024) throw new IllegalStateException("Server response is too large."); data.write(chunk, 0, length); }
            }
            JSONObject result;
            try { result = new JSONObject(data.toString(StandardCharsets.UTF_8.name())); }
            catch (Exception e) { throw new IllegalStateException("The site did not return API data (HTTP " + status + ")."); }
            if (status >= 400) {
                JSONObject error = result.optJSONObject("error");
                String message = error == null ? result.optString("message", "Request failed.") : error.optString("message", "Request failed.");
                throw new Failure(status, message);
            }
            return result;
        } finally { connection.disconnect(); }
    }
    static final class Failure extends Exception { final int status; Failure(int status, String message) { super(message); this.status = status; } }
}
