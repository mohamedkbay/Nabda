package ly.nabda.mobile;

import java.net.URI;
import java.util.Locale;

final class ServerPolicy {
    static String normalize(String value) throws Exception {
        if (value == null) throw new IllegalArgumentException("Enter the HTTPS address of your Nabda site.");
        URI uri = new URI(value.trim());
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("Use the HTTPS address of your Nabda site.");
        }
        if (uri.getPort() == 0 || uri.getPort() > 65535) throw new IllegalArgumentException("The server port is invalid.");
        if (uri.getPath() != null && !uri.getPath().isEmpty() && !"/".equals(uri.getPath())) throw new IllegalArgumentException("Use the site address without a path.");
        return new URI("https", null, uri.getHost().toLowerCase(Locale.ROOT), uri.getPort() == 443 ? -1 : uri.getPort(), null, null, null).toString();
    }
}
