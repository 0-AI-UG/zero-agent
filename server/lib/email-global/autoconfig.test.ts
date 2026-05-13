import { test, expect, describe } from "vitest";
import { parseAutoconfigXml } from "./autoconfig.ts";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

describe("parseAutoconfigXml", () => {
  test("extracts IMAP and SMTP endpoints with security mode", () => {
    const parsed = parseAutoconfigXml(SAMPLE, "user@example.com");
    expect(parsed.imap).toEqual({ host: "imap.example.com", port: 993, secure: "tls" });
    expect(parsed.smtp).toEqual({ host: "smtp.example.com", port: 587, secure: "starttls" });
  });

  test("substitutes %EMAILADDRESS% in hostnames", () => {
    const xml = SAMPLE.replace("imap.example.com", "%EMAILDOMAIN%-mail.example.com");
    const parsed = parseAutoconfigXml(xml, "user@example.com");
    expect(parsed.imap?.host).toBe("example.com-mail.example.com");
  });

  test("returns nulls on garbage input", () => {
    const parsed = parseAutoconfigXml("<not-config/>", "user@x.com");
    expect(parsed.imap).toBeNull();
    expect(parsed.smtp).toBeNull();
  });
});
