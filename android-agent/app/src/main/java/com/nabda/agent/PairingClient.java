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

/** Performs the one unauthenticated request allowed during local pairing. */
public final class PairingClient {
    private static final int MAX_RESPONSE_BYTES = 64 * 1024;

    public Result claim(String serverUrl, JSONObject request) throws PairingException {
        HttpURLConnection connection = null;
        try {
            String baseUrl = ServerUrlPolicy.normalize(serverUrl, false);
            connection = (HttpURLConnection) new URL(baseUrl + LocalProtocol.PAIRING_CLAIM_PATH).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(8_000);
            connection.setReadTimeout(10_000);
            connection.setRequestMethod("POST");
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
                throw new PairingException(safeError(status));
            }
            return parseResponse(response);
        } catch (PairingException error) {
            throw error;
        } catch (IOException error) {
            throw new PairingException("Cannot reach Nabda Desktop. Keep both devices on the same Wi-Fi.");
        } catch (JSONException error) {
            throw new PairingException("Nabda Desktop returned an invalid pairing response.");
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    static Result parseResponse(JSONObject response) throws PairingException {
        JSONObject data = response.optJSONObject("data");
        JSONObject value = data == null ? response : data;
        String token = first(value, "deviceToken", "device_token").trim();
        String deviceId = first(value, "deviceId", "device_id").trim();
        if (token.length() < 16 || token.length() > 1024 || deviceId.isEmpty() || deviceId.length() > 200) {
            throw new PairingException("Nabda Desktop did not issue valid device credentials.");
        }
        return new Result(deviceId, token);
    }

    private static String first(JSONObject value, String preferred, String fallback) {
        String result = value.optString(preferred, "");
        return result.isEmpty() ? value.optString(fallback, "") : result;
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

    private static String safeError(int status) {
        if (status == 404 || status == 409 || status == 410 || status == 422) {
            return "The pairing code is invalid, expired, or already used. Create a new code in Nabda Desktop.";
        }
        if (status == 429) {
            return "Too many pairing attempts. Wait, then create a new code.";
        }
        return "Pairing was declined by Nabda Desktop (" + status + ").";
    }

    public static final class Result {
        public final String deviceId;
        public final String deviceToken;

        Result(String deviceId, String deviceToken) {
            this.deviceId = deviceId;
            this.deviceToken = deviceToken;
        }
    }

    public static final class PairingException extends Exception {
        PairingException(String message) {
            super(message);
        }
    }
}
