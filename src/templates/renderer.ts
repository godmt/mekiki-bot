/**
 * Simple template renderer: replaces {key} placeholders with values.
 * No hardcoded UI text — all text comes from spec/templates.
 */
export function renderTemplate(
  template: string,
  context: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return key in context ? context[key] : match;
  });
}
