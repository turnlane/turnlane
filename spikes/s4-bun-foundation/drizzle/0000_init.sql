CREATE TABLE `events` (
  `id` text PRIMARY KEY NOT NULL,
  `source` text NOT NULL,
  `ts` integer NOT NULL,
  `kind` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_source_idx` ON `events` (`source`);
--> statement-breakpoint
CREATE TABLE `cursors` (
  `path` text PRIMARY KEY NOT NULL,
  `offset` integer NOT NULL
);
