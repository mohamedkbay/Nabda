import { describe, expect, it } from "vitest";
// The parser is deliberately shared with the dependency-free controller browser.
// @ts-expect-error JavaScript browser module has no generated declaration file.
import { contactsFromFile } from "../desktop/controller/web/contact-import.js";

describe("controller contact file parser", () => {
  it("reads the supplied httpsms export headers and expands semicolon-separated numbers", () => {
    const contacts = contactsFromFile(
      "Name,Emails,PhoneNumbers\nMohamed,,+218918019090\nWalid,,+218912166969;+218918970822\n",
      "httpsms-contacts-part-01-of-05.csv",
    );
    expect(contacts).toEqual([
      { name: "Mohamed", phone: "+218918019090" },
      { name: "Walid", phone: "+218912166969" },
      { name: "Walid", phone: "+218918970822" },
    ]);
  });

  it("handles quoted CSV values and removes duplicate phone numbers before upload", () => {
    const contacts = contactsFromFile(
      'Name,PhoneNumbers\n"A, B",+218910000001\nAgain,+218910000001\n',
      "contacts.csv",
    );
    expect(contacts).toEqual([{ name: "A, B", phone: "+218910000001" }]);
  });
});
