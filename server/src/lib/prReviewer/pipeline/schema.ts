import { z } from "zod";

/**
 * The stage outputs the LLM emits (reference §6.2) and the extended
 * chapters.json v1 document Assemble produces (reference §7 + PR-mode `pr`).
 */

export const PROMPT_VERSION = "1";
export const MAX_CHAPTERS = 12;
export const SUMMARY_MAX_WORDS = 80;

const text = z.string().trim().min(1);

export const outlineSchema = z.object({
  chapters: z.array(
    z.object({
      key: text,
      headline: text,
      runIds: z.array(z.string()),
    }),
  ),
  excluded: z.array(z.object({ runId: z.string(), reason: text })),
});
export type OutlineOutput = z.infer<typeof outlineSchema>;

export const writeSchema = z.object({
  intro: text,
  steps: z.array(z.object({ runIds: z.array(z.string()), explanation: text })),
});
export type WriteOutput = z.infer<typeof writeSchema>;

export const summarizeSchema = z.object({ title: text, summary: text });
export type SummarizeOutput = z.infer<typeof summarizeSchema>;

const range = z.tuple([z.number().int(), z.number().int()]);

export const chaptersDocumentSchema = z.object({
  version: z.literal(1),
  repo: z.string(),
  branch: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  generatedAt: z.iso.datetime(),
  model: z.string(),
  promptVersion: z.string(),
  fallbacks: z.array(
    z.union([
      z.literal("outline"),
      z.literal("summarize"),
      z.templateLiteral(["write:", z.string()]),
    ]),
  ),
  title: z.string(),
  summary: z.string(),
  commits: z.array(
    z.object({
      sha: z.string(),
      subject: z.string(),
      author: z.string(),
      date: z.string(),
    }),
  ),
  files: z.array(
    z.object({
      path: z.string(),
      oldPath: z.string().optional(),
      status: z.enum(["added", "modified", "deleted", "renamed"]),
      binary: z.boolean(),
      hunks: z.array(
        z.object({
          header: z.string(),
          oldStart: z.number().int(),
          oldLines: z.number().int(),
          newStart: z.number().int(),
          newLines: z.number().int(),
          lines: z.array(
            z.object({
              kind: z.enum([" ", "+", "-"]),
              oldNo: z.number().int().optional(),
              newNo: z.number().int().optional(),
              text: z.string(),
              runId: z.string().optional(),
            }),
          ),
        }),
      ),
    }),
  ),
  runs: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      commitSha: z.string(),
      added: z.number().int(),
      removed: z.number().int(),
      oldRange: range.optional(),
      newRange: range.optional(),
    }),
  ),
  chapters: z.array(
    z.object({
      key: z.string(),
      number: z.number().int().positive(),
      headline: z.string(),
      intro: z.string(),
      runIds: z.array(z.string()),
      steps: z.array(
        z.object({ runIds: z.array(z.string()), explanation: z.string() }),
      ),
    }),
  ),
  excluded: z.array(z.object({ runId: z.string(), reason: z.string() })),
  pr: z
    .object({
      number: z.number().int().positive(),
      title: z.string(),
      url: z.string(),
      host: z.string(),
      owner: z.string(),
      repo: z.string(),
    })
    .optional(),
});
export type ChaptersDocument = z.infer<typeof chaptersDocumentSchema>;
export type Fallback = ChaptersDocument["fallbacks"][number];
export type DocumentPr = NonNullable<ChaptersDocument["pr"]>;
