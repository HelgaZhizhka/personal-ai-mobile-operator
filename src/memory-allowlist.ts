import type { ReadableModule } from "./domain.js";

export interface AllowedMemoryDocument {
  module: ReadableModule;
  canonicalPath: string;
  maxBytes: number;
}

export const allowedMemoryDocuments: AllowedMemoryDocument[] = [
  {
    module: "current",
    canonicalPath: "00-Inbox/NOW.md",
    maxBytes: 60_000,
  },
  {
    module: "system",
    canonicalPath: "PROJECT.md",
    maxBytes: 80_000,
  },
  {
    module: "profile",
    canonicalPath: "01-Profile/profile.md",
    maxBytes: 80_000,
  },
  {
    module: "languages",
    canonicalPath: "03-Languages/languages.md",
    maxBytes: 80_000,
  },
  {
    module: "blog",
    canonicalPath: "04-Content-Blog/blog.md",
    maxBytes: 120_000,
  },
  {
    module: "projects",
    canonicalPath: "05-Projects/projects.md",
    maxBytes: 120_000,
  },
  {
    module: "subscriptions",
    canonicalPath: "06-Subscriptions-Tools/subscriptions.md",
    maxBytes: 80_000,
  },
];

