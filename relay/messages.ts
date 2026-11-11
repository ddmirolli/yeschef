// What the relay reads, as Schemas: the HTTP bodies, the messages on a team's socket, the roster it keeps, and what
// the Worker keeps on each socket while the object hibernates (docs/team-relay-v0_1.md). T3 Code's relay reads its
// inputs the same way: contract Schemas for its API, and a Schema for JSON it keeps in a column
// (infra/relay/src/hooks/HookInboxStore.ts).
//
// A body has one answer when it is not complete, so its Schema carries the formats (an id, a key, a sealed blob). A
// socket message's Schema checks that each field is there and of the right kind. The room then checks the values
// (sizes from the Worker's vars, membership, times) with their own answers, as before.
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

const pattern = (re: RegExp) => Schema.String.check(Schema.isPattern(re));
/** A 22-character id: a team, a member, an invite (client/seal.ts, isId). */
const Id = pattern(/^[A-Za-z0-9_-]{22}$/);
/** A raw P-256 public key (65 bytes), base64url. */
const Key = pattern(/^[A-Za-z0-9_-]{87}$/);
/** A sealed blob: the iv and the ciphertext, base64url. */
const Blob = pattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

/** A roster as its lead signed it. readRoster() (client/seal.ts) checks the body and the signature. */
export const SignedRoster = Schema.Struct({ body: Schema.String, sig: Schema.String });
export type SignedRoster = typeof SignedRoster.Type;

/** POST /v1/teams/:team: the team's first roster. */
export const CreateBody = Schema.Struct({ roster: SignedRoster });
/** POST /v1/teams/:team/join: an ask to join, with the invite's proof (client/seal.ts, joinRequest). */
export const JoinBody = Schema.Struct({
  invite: Id, proof: Schema.String, sign: Key, dh: Key, blob: Blob.check(Schema.isMaxLength(4096)), sig: Schema.String,
});

/** Any message on the socket: the id the app matches the answer by. The relay only sends it back. */
const Asked = Schema.Struct({ id: Schema.optional(Schema.Unknown) });
/** Its kind. */
const Kind = Schema.Struct({ t: Schema.String });
/** Each message a member sends, by its kind. */
const Messages = {
  summary: Schema.Struct({ t: Schema.Literal('summary'), blob: Schema.String }),
  forget: Schema.Struct({ t: Schema.Literal('forget') }),
  send: Schema.Struct({ t: Schema.Literal('send'), to: Schema.String, blob: Schema.String, ttl: Schema.optional(Schema.Number) }),
  done: Schema.Struct({ t: Schema.Literal('done'), item: Schema.String }),
  invite: Schema.Struct({ t: Schema.Literal('invite'), invite: Schema.String, verifier: Schema.String, box: Schema.String, until: Schema.Number }),
  revoke: Schema.Struct({ t: Schema.Literal('revoke'), invite: Schema.String }),
  decline: Schema.Struct({ t: Schema.Literal('decline'), m: Schema.String }),
  roster: Schema.Struct({ t: Schema.Literal('roster'), roster: SignedRoster }),
};
const Message = Schema.Union(Object.values(Messages));
export type Message = typeof Message.Type;

/** A frame as JSON, or none. */
export const fromJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
/** The id to answer with, from any message. */
export const askedId = (value: unknown): unknown => Option.getOrUndefined(Schema.decodeUnknownOption(Asked)(value))?.id;
/** The message's kind, or null when it has none. */
export const kindOf = (value: unknown): string | null => Option.getOrNull(Schema.decodeUnknownOption(Kind)(value))?.t ?? null;
/** True for a kind the relay knows. */
export const knows = (kind: string): boolean => Object.hasOwn(Messages, kind);
const decodeMessage = Schema.decodeUnknownOption(Message);
/** The message, or null when a field is missing or of the wrong kind. */
export const readMessage = (value: unknown): Message | null => Option.getOrNull(decodeMessage(value));
const decodeCreate = Schema.decodeUnknownOption(CreateBody);
export const readCreate = (value: unknown): typeof CreateBody.Type | null => Option.getOrNull(decodeCreate(value));
const decodeJoin = Schema.decodeUnknownOption(JoinBody);
export const readJoin = (value: unknown): typeof JoinBody.Type | null => Option.getOrNull(decodeJoin(value));

/** A member on the roster the relay keeps. readRoster() checked the id and the keys, and never the invite flag. */
const KeptMember = Schema.Struct({ id: Schema.String, sign: Schema.String, dh: Schema.String, invite: Schema.optional(Schema.Unknown) });
export type KeptMember = typeof KeptMember.Type;
const decodeKept = Schema.decodeOption(Schema.fromJsonString(SignedRoster));
const decodeMembers = Schema.decodeOption(Schema.fromJsonString(Schema.Struct({ members: Schema.Array(KeptMember) })));
const unreadable = () => new Error('The relay cannot read the roster it keeps.');
/** The signed roster in the team row. The relay wrote it after readRoster(), so a failure is the relay's own fault. */
export const keptRoster = (json: string): SignedRoster => Option.getOrThrowWith(decodeKept(json), unreadable);
/** Its members. */
export const keptMembers = (roster: SignedRoster): readonly KeptMember[] => Option.getOrThrowWith(decodeMembers(roster.body), unreadable).members;

/** What the Worker keeps on each socket: the member or waiting dev it signed in, and which of the two. */
export const SocketInfo = Schema.Struct({ m: Schema.String, role: Schema.Literals(['member', 'pending']) });
export type SocketInfo = typeof SocketInfo.Type;
const decodeInfo = Schema.decodeUnknownOption(SocketInfo);
/** A socket's info as the Worker kept it, or null. It outlives a deploy, so a newer relay may read an older one. */
export const readSocketInfo = (value: unknown): SocketInfo | null => Option.getOrNull(decodeInfo(value));
