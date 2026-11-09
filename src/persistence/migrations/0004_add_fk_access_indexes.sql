CREATE INDEX "messages_session_seq_idx" ON "messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "runs_session_status_idx" ON "runs" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "execution_events_run_seq_idx" ON "execution_events" USING btree ("run_id","seq");