// `[[step-1]]` at the very start of a paragraph renders as a chip, and a
// following `critical:` / `major:` / `minor:` as a severity badge: the ids
// agent reports (plans, reviews) open their items with. Both are trusted
// attrs, so a document's own `<span data-md-chip>` stays plain text. Chips
// render in every preview; MarkdownPreview makes them clickable (the block's
// comment composer) only where comments are on. See docs/markdown.md.

import type { MdExtension } from "../extension";
import { stampAttr } from "../trust";

export const CHIP_ATTR = "data-md-chip";
export const SEV_ATTR = "data-md-sev";
const ID_RE = /^\[\[([a-z]+-\d+)\]\](?=[ \t]|$)[ \t]*/;
const SEV_RE = /^(critical|major|minor):[ \t]*/;

export const idChips: MdExtension = {
  name: "idChips",
  trusted: { attrs: [CHIP_ATTR, SEV_ATTR] },
  plugin(md) {
    // pushed after text_join, so an escaped bracket is already one text token
    md.core.ruler.push("id_chips", (state) => {
      const ts = state.tokens;
      for (let i = 1; i < ts.length; i++) {
        const inline = ts[i];
        if (inline.type !== "inline" || ts[i - 1].type !== "paragraph_open") continue;
        const first = inline.children?.[0];
        if (first?.type !== "text") continue;
        const id = ID_RE.exec(first.content);
        if (!id) continue;
        let rest = first.content.slice(id[0].length);
        const out = [];
        const chip = new state.Token("md_chip", "span", 0);
        chip.content = id[1];
        stampAttr(chip, CHIP_ATTR, id[1]);
        out.push(chip);
        const sev = SEV_RE.exec(rest);
        if (sev) {
          const badge = new state.Token("md_sev", "span", 0);
          badge.content = sev[1];
          stampAttr(badge, SEV_ATTR, sev[1]);
          out.push(badge);
          rest = rest.slice(sev[0].length);
        }
        if (rest) {
          first.content = rest;
          out.push(first);
        }
        inline.children!.splice(0, 1, ...out);
      }
    });
    md.renderer.rules.md_chip = md.renderer.rules.md_sev = (tokens, i, _o, _e, self) =>
      `<span${self.renderAttrs(tokens[i])}>${md.utils.escapeHtml(tokens[i].content)}</span>`;
  },
};
