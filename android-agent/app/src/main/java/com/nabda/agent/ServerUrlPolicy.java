package com.nabda.agent;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Pins Desktop traffic to literal RFC 1918 IPv4 addresses on the current LAN. */
public final class ServerUrlPolicy {
    private ServerUrlPolicy() {}

    public static String normalize(String rawValue, boolean debugBuild) {
        String raw = rawValue == null ? "" : rawValue.trim();
        if (raw.isEmpty()) {
            throw new IllegalArgumentException("Enter the server URL.");
        }

        final URI uri;
        try {
            uri = new URI(raw);
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Enter a valid server URL.");
        }

        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        if (host.isEmpty() || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("Use a server URL without credentials, query, or fragment.");
        }

        if (!"http".equals(scheme)) {
            throw new IllegalArgumentException("Use the local HTTP address shown by Nabda Desktop.");
        }
        if (!isPrivateIpv4(host)) {
            throw new IllegalArgumentException("Use the private IPv4 address shown by Nabda Desktop (10.x, 172.16–31.x, or 192.168.x).");
        }
        if (uri.getPath() != null && !uri.getPath().isEmpty() && !"/".equals(uri.getPath())) {
            throw new IllegalArgumentException("Use the Desktop address without an extra path.");
        }
        if (uri.getPort() <= 0 || uri.getPort() > 65535) {
            throw new IllegalArgumentException("The Desktop port is invalid.");
        }

        String normalized = uri.normalize().toString();
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    static boolean isPrivateIpv4(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) {
            return false;
        }
        int[] octets = new int[4];
        for (int index = 0; index < parts.length; index++) {
            if (parts[index].isEmpty() || !parts[index].matches("[0-9]{1,3}")) {
                return false;
            }
            try {
                octets[index] = Integer.parseInt(parts[index]);
            } catch (NumberFormatException ignored) {
                return false;
            }
            if (octets[index] < 0 || octets[index] > 255) {
                return false;
            }
        }
        return octets[0] == 10
                || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                || (octets[0] == 192 && octets[1] == 168);
    }
}
