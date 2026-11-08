package ly.nabda.mobile;

/** Formatting only: normalization is not proof of subscriber ownership. */
final class PhoneNumber {
    static String normalize(String raw) {
        if (raw == null) return null;
        String p = raw.replaceAll("[\\s()\\-]", "");
        if (p.matches("0[0-9]{9}")) p = "+218" + p.substring(1);
        else if (p.matches("218[0-9]{9}")) p = "+" + p;
        if (p.startsWith("00")) p = "+" + p.substring(2);
        return p.matches("\\+[1-9][0-9]{6,14}") ? p : null;
    }
}
