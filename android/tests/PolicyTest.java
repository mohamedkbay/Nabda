package ly.nabda.mobile;

/** JVM checks use no Android device or SMS permission. */
public final class PolicyTest {
    private static int assertions;
    private static void equal(String actual, String expected) {
        assertions++;
        if (!java.util.Objects.equals(actual, expected)) throw new AssertionError("Expected " + expected + ", got " + actual);
    }
    private static void rejected(String value) throws Exception {
        assertions++;
        try { ServerPolicy.normalize(value); } catch (Exception expected) { return; }
        throw new AssertionError("Unsafe server accepted: " + value);
    }
    public static void main(String[] args) throws Exception {
        equal(ServerPolicy.normalize(" https://EXAMPLE.com/ "), "https://example.com");
        equal(ServerPolicy.normalize("https://example.com:443"), "https://example.com");
        equal(ServerPolicy.normalize("https://example.com:8443"), "https://example.com:8443");
        for (String invalid : new String[]{"http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com?token=secret", "https://example.com/#secret", "javascript:alert(1)", "https://example.com:0", "https://example.com:70000", "https:///example.com", null}) rejected(invalid);
        equal(PhoneNumber.normalize("091 234-5678"), "+218912345678");
        equal(PhoneNumber.normalize("+218912345678"), "+218912345678");
        equal(PhoneNumber.normalize("218912345678"), "+218912345678");
        equal(PhoneNumber.normalize("00218912345678"), "+218912345678");
        equal(PhoneNumber.normalize("+447700900000"), "+447700900000");
        equal(PhoneNumber.normalize("nobody"), null);
        equal(PhoneNumber.normalize("+012345678"), null);
        equal(PhoneNumber.normalize(null), null);
        System.out.println("Passed " + assertions + " server/phone policy assertions; no SMS sent.");
    }
}
