import { main } from "../src/cli.ts";
import type { Deps } from "../src/harness.ts";

export async function cli(d: Deps, argv: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => {
    out.push(a.join(" "));
  };
  try {
    return { code: await main(argv, d), out: out.join("\n") };
  } finally {
    console.log = log;
  }
}
