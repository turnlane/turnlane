-- 0019: サブエージェントの中で出た hook の agent_id・agent_type（Claude Code。session_external_id は親のセッション）と権限のモード（permission_mode）
ALTER TABLE `hook_event` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `hook_event` ADD `agent_type` text;--> statement-breakpoint
ALTER TABLE `hook_event` ADD `permission_mode` text;