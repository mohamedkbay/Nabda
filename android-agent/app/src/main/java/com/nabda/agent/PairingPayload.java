package com.nabda.agent;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** Parses only Nabda's versioned, one-time controller pairing payload. */
public final class PairingPayload {
    public final String serverUrl;
    public final String pairingToken;

    private PairingPayload(String serverUrl, String pairingToken) {
        this.serverUrl = serverUrl;
        this.pairingToken = pairingToken;
    }

    public static PairingPayload parse(String rawValue, boolean debugBuild) {
        String raw = rawValue == null ? "" : rawValue.trim();
        if (raw.isEmpty() || raw.length() > 2048) {
            throw new IllegalArgumentException("This is not a valid Nabda pairing code.");
        }
        try {
            URI uri = new URI(raw);
            if (!"nabda".equalsIgnoreCase(uri.getScheme())
                    || !"pair".equalsIgnoreCase(uri.getHost())
                    || uri.getFragment() != null
                    || (uri.getPath() != null && !uri.getPath().isEmpty())) {
                throw new IllegalArgumentException("This is not a Nabda controller QR code.");
            }
            Map<String, String> values = query(uri.getRawQuery());
            if (!"1".equals(values.get("v"))) {
                throw new IllegalArgumentException("This pairing code version is not supported.");
            }
            String server = ServerUrlPolicy.normalize(values.get("server"), debugBuild);
            String token = values.get("token");
            if (token == null || !token.matches("nbda_pair_[A-Za-z0-9_-]{40,100}")) {
                throw new IllegalArgumentException("This pairing code is incomplete.");
            }
            return new PairingPayload(server, token);
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("This is not a valid Nabda pairing code.");
        }
    }

    private static Map<String, String> query(String rawQuery) throws Exception {
        if (rawQuery == null || rawQuery.isEmpty()) {
            throw new IllegalArgumentException("This pairing code is incomplete.");
        }
        Map<String, String> values = new HashMap<>();
        for (String pair : rawQuery.split("&")) {
            String[] parts = pair.split("=", 2);
            if (parts.length != 2) continue;
            String key = URLDecoder.decode(parts[0], StandardCharsets.UTF_8.name());
            String value = URLDecoder.decode(parts[1], StandardCharsets.UTF_8.name());
            if (values.put(key, value) != null) {
                throw new IllegalArgumentException("This pairing code contains duplicate fields.");
            }
        }
        return values;
    }
}
