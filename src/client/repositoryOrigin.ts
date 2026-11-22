// Only an exact clone URL identifies a checkout. Never serialize arbitrary remote text.
export function githubOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 200 || /\s/.test(value)) return;
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9._-]{1,104})\/?$/i.exec(value);
  if (!match) return;
  const name = match[2]!.replace(/\.git$/i, "");
  if (!name || name.length > 100 || name === "." || name === "..") return;
  if (/(?:cot_|gh[pousr]_|github_pat_|AKIA|ASIA|sk-|xox[baprs]-|npm_|AIza|eyJ)[a-z0-9_-]{12,}/i.test(match[1] + "/" + name)) return;
  return "https://github.com/" + match[1] + "/" + name;
}
