// GitHub's REST replies, as far as the Pass reads them (client/github.ts, client/pr-runs.ts), read through Schemas as
// T3 Code reads gh's replies (packages/source-control-github/src/server/GitHubSourceControlProvider.ts). GitHub's data
// is read, not trusted. A field the reads can do without may be missing, or null where GitHub sends null, as the
// reads always allowed. A field of another kind, or a reply that is not the object or list GitHub sends, fails the
// read: it is "not checked", never a guess made from it.
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

const maybe = <S extends Schema.Top>(s: S) => Schema.optional(Schema.NullOr(s));

/** A git commit's message and times (a branch's head, a pull request's commits, a branch's history). */
const GitUser = Schema.Struct({ date: Schema.optional(Schema.String) });
export const GitCommit = Schema.Struct({ message: Schema.optional(Schema.String), committer: maybe(GitUser), author: maybe(GitUser) });
export type GitCommit = typeof GitCommit.Type;

/** One check run, and one commit status. */
export const CheckRun = Schema.Struct({
  id: Schema.optional(Schema.Number), name: Schema.optional(Schema.String), status: Schema.optional(Schema.String), conclusion: maybe(Schema.String),
  app: maybe(Schema.Struct({ id: Schema.optional(Schema.Number) })),
  html_url: maybe(Schema.String), details_url: maybe(Schema.String), completed_at: maybe(Schema.String), started_at: maybe(Schema.String),
});
export type CheckRun = typeof CheckRun.Type;
export const Status = Schema.Struct({
  context: Schema.optional(Schema.String), state: Schema.optional(Schema.String), target_url: maybe(Schema.String), updated_at: maybe(Schema.String),
});
export type Status = typeof Status.Type;
/** A page of a commit's check runs, and of its combined status: the total says whether the list is whole. */
export const CheckRunsPage = Schema.Struct({ total_count: Schema.Number, check_runs: Schema.Array(CheckRun) });
export const StatusesPage = Schema.Struct({ total_count: Schema.Number, statuses: Schema.Array(Status) });

/** A branch, with its head commit and its classic protection. */
export const Branch = Schema.Struct({
  commit: Schema.optional(Schema.Struct({ sha: Schema.optional(Schema.String), commit: Schema.optional(GitCommit) })),
  protected: Schema.optional(Schema.Boolean),
  protection: Schema.optional(Schema.Struct({
    required_status_checks: Schema.optional(Schema.Struct({
      contexts: Schema.optional(Schema.Array(Schema.String)),
      checks: Schema.optional(Schema.Array(Schema.Struct({ context: Schema.String, app_id: maybe(Schema.Number) }))),
    })),
  })),
});
/** One rule on a branch (rulesets). Only required_status_checks carries checks. */
export const Rule = Schema.Struct({
  type: Schema.optional(Schema.String),
  parameters: maybe(Schema.Struct({
    required_status_checks: Schema.optional(Schema.Array(Schema.Struct({ context: Schema.String, integration_id: maybe(Schema.Number) }))),
  })),
});
export type Rule = typeof Rule.Type;

/** A pull request: its state, head and base, totals, and merge commit. */
export const PullRequest = Schema.Struct({
  html_url: Schema.optional(Schema.String), state: Schema.optional(Schema.String), merged: Schema.optional(Schema.Boolean), draft: Schema.optional(Schema.Boolean),
  head: Schema.optional(Schema.Struct({ sha: Schema.optional(Schema.String) })),
  base: Schema.optional(Schema.Struct({ ref: Schema.optional(Schema.String), sha: Schema.optional(Schema.String) })),
  additions: Schema.optional(Schema.Number), deletions: Schema.optional(Schema.Number), changed_files: Schema.optional(Schema.Number),
  commits: Schema.optional(Schema.Number), merge_commit_sha: maybe(Schema.String), created_at: Schema.optional(Schema.String),
  // Who is asked to review now: people and teams. GitHub takes a person off when they review, and puts them back on a re-request.
  requested_reviewers: Schema.optional(Schema.Array(Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) })))),
  requested_teams: Schema.optional(Schema.Array(Schema.NullOr(Schema.Struct({ slug: Schema.optional(Schema.String) })))),
  // Its description: French Brigade reads a "Blocked by #N" or "Depends on #N" line from it (step 7 PR 2, 3C).
  body: maybe(Schema.String),
});
export type PullRequest = typeof PullRequest.Type;
/** An issue or pull request's state, as repos/<repo>/issues/<n> gives it ("open" or "closed"; a merged PR is closed). */
export const IssueState = Schema.Struct({ state: Schema.optional(Schema.String) });
/** One review on a pull request: who, their verdict, and when they sent it. */
export const Review = Schema.Struct({ user: maybe(Schema.Struct({ login: Schema.optional(Schema.String) })), state: Schema.optional(Schema.String), submitted_at: maybe(Schema.String) });
/** One file a pull request changes. */
export const PrFile = Schema.Struct({ filename: Schema.String, additions: Schema.optional(Schema.Number), deletions: Schema.optional(Schema.Number) });
/** One commit in a list: a pull request's commits, or a branch's history. */
export const Commit = Schema.Struct({ sha: Schema.String, commit: Schema.optional(GitCommit), parents: Schema.optional(Schema.Array(Schema.Struct({ sha: Schema.String }))) });
export type Commit = typeof Commit.Type;
/** One event on an issue or pull request. */
export const IssueEvent = Schema.Struct({ event: Schema.optional(Schema.String), created_at: Schema.optional(Schema.String) });

// The lists GitHub sends as a bare array.
export const Rules = Schema.Array(Rule);
export const PrFiles = Schema.Array(PrFile);
export const Commits = Schema.Array(Commit);
export const IssueEvents = Schema.Array(IssueEvent);
export const Reviews = Schema.Array(Review);

/** A GitHub reply the Pass cannot read. Its reason is what "not checked" says. */
export class GitHubReadError extends Schema.TaggedError<GitHubReadError>()('GitHubReadError', { reason: Schema.String }) {
  override get message(): string { return this.reason; }
}

/** The reply read through `schema`, or none. */
export const read = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) => {
  const decode = Schema.decodeUnknownOption(schema);
  return (reply: unknown): Option.Option<S['Type']> => decode(reply);
};
/** The reply read through `schema`; a reply GitHub would never send throws, so the read is "not checked". */
export const must = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, what: string) => {
  const decode = Schema.decodeUnknownOption(schema);
  return (reply: unknown): S['Type'] => Option.getOrThrowWith(decode(reply), () => new GitHubReadError({ reason: `GitHub sent ${what} the Pass cannot read` }));
};
/** gh's output as JSON. */
export const fromJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
