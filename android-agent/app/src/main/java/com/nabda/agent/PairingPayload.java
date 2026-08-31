package com.nabda.agent;

import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** Strict parser for QR links emitted by Nabda Desktop. */
public final class PairingPayload {
    public final String serverUrl;
    public final String pairingCode;
    public final String desktopId;

    private PairingPayload(String serverUrl, String pairingCode, String desktopId) {
        this.serverUrl = serverUrl;
        this.pairingCode = pairingCode;
        this.desktopId = desktopId;
    }

    public static PairingPayload fromQrUri(String rawValue) {
        final URI uri;
        try {
            uri = new URI(rawValue == null ? "" : rawValue.trim());
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("This is not a valid Nabda pairing QR.");
        }
        if (!"nabda".equalsIgnoreCase(uri.getScheme())
                || !"pair".equalsIgnoreCase(uri.getHost())
                || uri.getUserInfo() != null
                || uri.getFragment() != null
                || (uri.getPath() != null && !uri.getPath().isEmpty())) {
            throw new IllegalArgumentException("This QR was not created by Nabda Desktop.");
        }

        Map<String, String> query = parseQuery(uri.getRawQuery());
        if (query.size() != 4
                || !"1".equals(query.get("v"))
                || !query.containsKey("endpoint")
                || !query.containsKey("code")
                || !query.containsKey("desktop")) {
            throw new IllegalArgumentException("The pairing QR has unexpected fields.");
        }
        String desktopId = query.get("desktop") == null ? "" : query.get("desktop").trim();
        if (!desktopId.matches("[A-Za-z0-9_-]{2,32}")) {
            throw new IllegalArgumentException("The Desktop identity in this QR is invalid.");
        }
        PairingPayload manual = fromManual(query.get("endpoint"), query.get("code"));
        return new PairingPayload(manual.serverUrl, manual.pairingCode, desktopId);
    }

    public static PairingPayload fromManual(String serverUrl, String pairingCode) {
        String normalizedServer = ServerUrlPolicy.normalize(serverUrl, false);
        String normalizedCode = pairingCode == null ? "" : pairingCode.trim();
        if (!normalizedCode.matches("[A-Za-z0-9_-]{43}")) {
            throw new IllegalArgumentException("Paste the one-time pairing secret shown by Nabda Desktop.");
        }
        return new PairingPayload(normalizedServer, normalizedCode, "manual");
    }

    private static Map<String, String> parseQuery(String rawQuery) {
        if (rawQuery == null || rawQuery.isEmpty()) {
            throw new IllegalArgumentException("The pairing QR is incomplete.");
        }
        Map<String, String> values = new HashMap<>();
        for (String pair : rawQuery.split("&", -1)) {
            int separator = pair.indexOf('=');
            if (separator <= 0) {
                throw new IllegalArgumentException("The pairing QR is malformed.");
            }
            String key = decode(pair.substring(0, separator));
            String value = decode(pair.substring(separator + 1));
            if (values.put(key, value) != null) {
                throw new IllegalArgumentException("The pairing QR contains duplicate fields.");
            }
        }
        return values;
    }

    private static String decode(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
        } catch (Exception error) {
            throw new IllegalArgumentException("The pairing QR is malformed.");
        }
    }
}
