package com.nabda.agent;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class ApiClient {
    private static final int MAX_RESPONSE_BYTES = 256 * 1024;

    private final String baseUrl;
    private final String deviceToken;

    public ApiClient(String baseUrl, String deviceToken) {
        this.baseUrl = ServerUrlPolicy.normalize(baseUrl, BuildConfig.DEBUG);
        this.deviceToken = deviceToken;
    }

    public JSONObject post(String path, JSONObject request) throws ApiException {
        return post(path, request, true);
    }

    public static JSONObject pair(String baseUrl, String pairingToken) throws ApiException {
        JSONObject request = new JSONObject();
        try {
            request.put("pairing_token", pairingToken);
            request.put("app_version", BuildConfig.VERSION_NAME);
            request.put("android_version", android.os.Build.VERSION.RELEASE);
            request.put("simulated", BuildConfig.SIMULATION_ONLY);
        } catch (JSONException error) {
            throw new ApiException(0, "Could not prepare the pairing request.", error);
        }
        return new ApiClient(baseUrl, "").post("/v1/device/pair", request, false);
    }

    private JSONObject post(String path, JSONObject request, boolean authenticated) throws ApiException {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(baseUrl + path);
            connection = (HttpURLConnection) url.openConnection();
            // A redirect must never forward the device bearer token to another host.
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(15_000);
            connection.setRequestMethod("POST");
            if (authenticated) {
                connection.setRequestProperty("Authorization", "Bearer " + deviceToken);
            }
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("User-Agent", "NabdaAndroidAgent/" + BuildConfig.VERSION_NAME);
            connection.setDoOutput(true);

            byte[] body = request.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300
                    ? connection.getInputStream()
                    : connection.getErrorStream();
            String responseBody = stream == null ? "" : readLimited(stream);
            JSONObject response = responseBody.isEmpty() ? new JSONObject() : new JSONObject(responseBody);
            if (status < 200 || status >= 300) {
                throw new ApiException(status, safeError(response, status));
            }
            return response;
        } catch (ApiException error) {
            throw error;
        } catch (IOException error) {
            throw new ApiException(0, "Cannot reach the server. Check the connection and server URL.", error);
        } catch (JSONException error) {
            throw new ApiException(0, "The server returned an invalid response.", error);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String readLimited(InputStream input) throws IOException {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int total = 0;
            int count;
            while ((count = stream.read(buffer)) != -1) {
                total += count;
                if (total > MAX_RESPONSE_BYTES) {
                    throw new IOException("Response is too large");
                }
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String safeError(JSONObject response, int status) {
        JSONObject error = response.optJSONObject("error");
        String code = error == null ? response.optString("code") : error.optString("code");
        if ("invalid_pairing_token".equals(code) || "pairing_expired".equals(code)) {
            return "This QR code is no longer valid. Create a new one in the controller.";
        }
        if (status == 401 || status == 403) {
            return "The device token was rejected.";
        }
        if (status == 409 || status == 410) {
            return code.isEmpty() ? "The message lease is no longer valid." : code;
        }
        if (status == 429) {
            return "The server asked this phone to slow down.";
        }
        String message = error == null ? response.optString("message") : error.optString("message");
        if (!message.isEmpty() && message.length() <= 200) {
            return message;
        }
        return code.isEmpty() ? "Server request failed (" + status + ")." : code;
    }

    public static final class ApiException extends Exception {
        public final int statusCode;

        ApiException(int statusCode, String message) {
            super(message);
            this.statusCode = statusCode;
        }

        ApiException(int statusCode, String message, Throwable cause) {
            super(message, cause);
            this.statusCode = statusCode;
        }

        public boolean isAuthenticationFailure() {
            return statusCode == 401 || statusCode == 403;
        }

        public boolean isSafetyRejection() {
            return statusCode == 404 || statusCode == 409 || statusCode == 410 || statusCode == 422;
        }
    }
}
