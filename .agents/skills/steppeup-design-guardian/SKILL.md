---
name: steppeup-design-guardian
description: Preserve and improve the SteppeUp student job-app visual system when editing its interface, cards, themes, or responsive behavior.
---

# SteppeUp Design Guardian

Use this skill for SteppeUp UI work. Its purpose is to keep the product warm,
clear, student-friendly, and consistent as the application evolves.

## Visual language

- Use warm off-white surfaces, restrained pastel yellow and sage accents, and
  crisp near-black text. In dark mode use deep forest surfaces with muted amber
  and sage accents; do not simply invert the light palette.
- Treat gradients as quiet background atmosphere only. Cards and readable text
  need opaque, high-contrast surfaces.
- Browse is a practical search workspace. Home is a curated weekly edit with
  one clear leading opportunity and deliberate, non-repetitive collections.
- Use the source label, role, employer, location, salary, and useful tags as a
  job card's identity. Do not generate initials or fake employer marks. Only
  use a verified employer logo when a real asset is available.

## Match and card rules

- Do not alter ranking or score calculations for visual work. Present their
  output consistently: 85–100 is sage and labelled as an excellent fit, 70–84
  is pastel yellow and labelled as a good option, and lower scores are warm
  neutral and labelled as an opportunity to explore.
- Match colour is an accent on a compact chip and slim rail, never a full card
  background and never the only way to understand the score.
- Prioritize readable title wrapping and factual scanning over decorative UI.
  Keep save, details, and keyboard navigation intact.

## Interaction and responsiveness

- Keep touch targets at least 44px where practical, focus states visible, and
  contrast sufficient in both themes.
- Prefer 180–240ms transform/opacity or colour transitions. Respect
  `prefers-reduced-motion`; never rely on animation to communicate state.
- Validate layouts at 375px, 737px, 904px, and desktop widths with no
  horizontal overflow. On small screens, favor an intentional horizontal card
  rail or single-column feature over squeezed multi-column cards.
