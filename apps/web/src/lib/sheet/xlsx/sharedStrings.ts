/** xl/sharedStrings.xml: every distinct text literal once, referenced by index. */

import { cellText, NS, textElement, XML_HEADER, type WarningLog } from "./xml";

export class SharedStrings {
  private readonly indexes = new Map<string, number>();
  private readonly items: string[] = [];
  private references = 0;

  constructor(private readonly log: WarningLog) {}

  /** The index of the (cleaned) text, adding it on first use. */
  index(text: string): number {
    const clean = cellText(text, this.log);
    this.references += 1;
    const known = this.indexes.get(clean);
    if (known !== undefined) return known;
    this.items.push(clean);
    this.indexes.set(clean, this.items.length - 1);
    return this.items.length - 1;
  }

  toXml(): string {
    const items = this.items.map((item) => `<si>${textElement("t", item)}</si>`).join("");
    return `${XML_HEADER}<sst xmlns="${NS.main}" count="${this.references}" uniqueCount="${this.items.length}">${items}</sst>`;
  }
}
