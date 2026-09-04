// 本文件由 scripts/gen-zcode-schema.ts 从真实 ~/.zcode/cli/db/db.sqlite 导出，请勿手改。
// 用途：zcode adapter 需要在临时目录或远端主机上**从零建库**再 INSERT，
// 因此把 zcode 自己建库时的完整 DDL（19 张表 + 39 个索引
// + 2 个触发器）与 schema_migration 账本原样内嵌 ——
// 缺一张表会让 zcode 查询时报 "no such table"，缺迁移记录会让它以为需要重新迁移。
export const ZCODE_SCHEMA_SQL: string[] = [
  // ---- table schema_migration
  "CREATE TABLE schema_migration (\n        id text primary key,\n        checksum text not null,\n        app_version text,\n        time_applied integer not null\n      )",
  // ---- table session
  "CREATE TABLE session (\n        id text primary key,\n        project_id text not null,\n        workspace_id text,\n        parent_id text,\n        slug text not null,\n        directory text not null,\n        path text,\n        title text not null,\n        version text not null,\n        share_url text,\n        summary_additions integer,\n        summary_deletions integer,\n        summary_files integer,\n        summary_diffs text,\n        revert text,\n        permission text,\n        time_created integer not null,\n        time_updated integer not null,\n        time_compacting integer,\n        time_archived integer\n      , task_type text not null default 'interactive', title_source text not null default 'first_input'\n        check(title_source in ('default', 'first_input', 'generated', 'custom')), title_message_id text, time_title_updated integer, trace_id text)",
  // ---- table message
  "CREATE TABLE message (\n        id text primary key,\n        session_id text not null references session(id) on delete cascade,\n        time_created integer not null,\n        time_updated integer not null,\n        data text not null\n      , sequence integer)",
  // ---- table part
  "CREATE TABLE part (\n        id text primary key,\n        message_id text not null references message(id) on delete cascade,\n        session_id text not null,\n        time_created integer not null,\n        time_updated integer not null,\n        data text not null\n      , sequence integer)",
  // ---- table todo
  "CREATE TABLE todo (\n        session_id text not null references session(id) on delete cascade,\n        content text not null,\n        status text not null,\n        priority text not null,\n        position integer not null,\n        time_created integer not null,\n        time_updated integer not null,\n        primary key(session_id, position)\n      )",
  // ---- table session_entry
  "CREATE TABLE session_entry (\n        id text primary key,\n        session_id text not null references session(id) on delete cascade,\n        type text not null,\n        time_created integer not null,\n        time_updated integer not null,\n        data text not null\n      )",
  // ---- table permission
  "CREATE TABLE permission (\n        project_id text primary key,\n        time_created integer not null,\n        time_updated integer not null,\n        data text not null\n      )",
  // ---- table input_history
  "CREATE TABLE input_history (\n        id text primary key,\n        project_id text not null,\n        session_id text,\n        text text not null,\n        kind text not null,\n        time_created integer not null\n      , attachments text)",
  // ---- table local_setting
  "CREATE TABLE local_setting (\n        scope text not null,\n        scope_id text not null,\n        namespace text not null,\n        key text not null,\n        value text not null,\n        schema_version integer not null,\n        time_created integer not null,\n        time_updated integer not null,\n        primary key(scope, scope_id, namespace, key)\n      )",
  // ---- table session_target
  "CREATE TABLE \"session_target\" (\n        session_id text primary key references session(id) on delete cascade,\n        target_id text not null,\n        objective text not null,\n        status text not null check(status in ('active', 'paused', 'budget_limited', 'complete')),\n        token_budget integer,\n        tokens_used integer not null default 0,\n        time_used_seconds integer not null default 0,\n        time_created integer not null,\n        time_updated integer not null\n      , summary_title text, active_input_id text, active_run_started_at integer, active_run_last_seen_at integer)",
  // ---- table workflow_definition
  "CREATE TABLE workflow_definition (\n        id text primary key,\n        name text not null,\n        source text not null check(source in ('builtin', 'user')),\n        trusted integer not null default 0 check(trusted in (0, 1)),\n        enabled integer not null default 1 check(enabled in (0, 1)),\n        script_path text,\n        script_hash text not null,\n        meta_json text not null,\n        time_created integer not null,\n        time_updated integer not null\n      , scope text not null default 'explicit'\n        check(scope in ('builtin', 'explicit', 'project', 'user')))",
  // ---- table workflow_run
  "CREATE TABLE workflow_run (\n        id text primary key,\n        definition_id text,\n        name text not null,\n        kind text not null default 'script',\n        parent_session_id text references session(id) on delete set null,\n        cwd text not null,\n        script_path text,\n        script_hash text not null,\n        args_json text,\n        args_hash text,\n        status text not null check(status in (\n          'pending',\n          'running',\n          'paused',\n          'completed',\n          'failed',\n          'cancelled'\n        )),\n        current_phase text,\n        budget_total integer,\n        budget_spent integer not null default 0,\n        stats_json text,\n        failure_json text,\n        time_created integer not null,\n        time_started integer,\n        time_updated integer not null,\n        time_completed integer\n      )",
  // ---- table workflow_activity
  "CREATE TABLE workflow_activity (\n        id text primary key,\n        run_id text not null references workflow_run(id) on delete cascade,\n        parent_activity_id text,\n        call_index integer not null,\n        call_path text not null,\n        attempt integer not null default 1,\n        type text not null,\n        phase text,\n        label text,\n        input_hash text not null,\n        prompt text,\n        opts_json text,\n        status text not null check(status in (\n          'queued',\n          'running',\n          'completed',\n          'failed',\n          'skipped',\n          'cancelled',\n          'cached',\n          'lost'\n        )),\n        child_session_id text references session(id) on delete set null,\n        result_json text,\n        error_json text,\n        time_created integer not null,\n        time_started integer,\n        time_updated integer not null,\n        time_completed integer,\n        unique(run_id, call_path, attempt)\n      )",
  // ---- table workflow_event
  "CREATE TABLE workflow_event (\n        id text primary key,\n        run_id text not null references workflow_run(id) on delete cascade,\n        sequence integer not null,\n        type text not null,\n        phase text,\n        activity_id text references workflow_activity(id) on delete set null,\n        payload_json text,\n        time_created integer not null,\n        unique(run_id, sequence)\n      )",
  // ---- table session_task_link
  "CREATE TABLE session_task_link (\n        id text primary key,\n        root_workflow_run_id text references workflow_run(id) on delete cascade,\n        parent_link_id text references session_task_link(id) on delete cascade,\n        activity_id text references workflow_activity(id) on delete set null,\n        parent_session_id text references session(id) on delete set null,\n        child_session_id text not null references session(id) on delete cascade,\n        role text not null,\n        depth integer not null default 0,\n        path text not null,\n        phase text,\n        label text,\n        agent_type text,\n        model text,\n        status text not null,\n        time_created integer not null,\n        time_updated integer not null,\n        unique(child_session_id)\n      )",
  // ---- table model_usage
  "CREATE TABLE model_usage (\n        id text primary key,\n        logical_request_id text not null,\n        attempt_index integer not null default 0,\n        session_id text not null references session(id) on delete cascade,\n        turn_id text,\n        trace_id text,\n        span_id text,\n        assistant_message_id text,\n        parent_user_message_id text,\n        query_source text not null,\n        provider_id text not null,\n        model_id text not null,\n        variant text,\n        agent text,\n        mode text,\n        task_type text,\n        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),\n        started_at integer not null,\n        first_token_at integer,\n        completed_at integer,\n        duration_ms integer,\n        time_to_first_token_ms integer,\n        finish_reason text,\n        tool_call_count integer not null default 0,\n        input_tokens integer not null default 0,\n        output_tokens integer not null default 0,\n        reasoning_tokens integer not null default 0,\n        cache_creation_input_tokens integer not null default 0,\n        cache_read_input_tokens integer not null default 0,\n        provider_total_tokens integer,\n        computed_total_tokens integer not null default 0,\n        retry_count integer not null default 0,\n        retryable integer not null default 0 check(retryable in (0, 1)),\n        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),\n        context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),\n        error_type text,\n        error_code text,\n        error_message text,\n        raw_usage_json text,\n        provider_metadata_json text\n      )",
  // ---- table turn_usage
  "CREATE TABLE turn_usage (\n        session_id text not null references session(id) on delete cascade,\n        turn_id text not null,\n        trace_id text,\n        user_message_id text,\n        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),\n        started_at integer not null,\n        first_model_start_at integer,\n        first_token_at integer,\n        completed_at integer,\n        duration_ms integer,\n        time_to_first_token_ms integer,\n        model_request_count integer not null default 0,\n        model_retry_count integer not null default 0,\n        tool_call_count integer not null default 0,\n        tool_error_count integer not null default 0,\n        input_tokens integer not null default 0,\n        output_tokens integer not null default 0,\n        reasoning_tokens integer not null default 0,\n        cache_creation_input_tokens integer not null default 0,\n        cache_read_input_tokens integer not null default 0,\n        computed_total_tokens integer not null default 0,\n        retryable integer not null default 0 check(retryable in (0, 1)),\n        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),\n        context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),\n        error_type text,\n        error_code text,\n        primary key(session_id, turn_id)\n      )",
  // ---- table tool_usage
  "CREATE TABLE tool_usage (\n        id text primary key,\n        session_id text not null references session(id) on delete cascade,\n        turn_id text,\n        trace_id text,\n        tool_call_id text not null,\n        tool_name text not null,\n        side_effect_scope text,\n        read_only integer check(read_only in (0, 1)),\n        destructive integer check(destructive in (0, 1)),\n        approval_status text,\n        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),\n        started_at integer not null,\n        first_output_at integer,\n        completed_at integer,\n        duration_ms integer,\n        time_to_first_output_ms integer,\n        exit_code integer,\n        output_bytes integer not null default 0,\n        stdout_bytes integer not null default 0,\n        stderr_bytes integer not null default 0,\n        truncated integer not null default 0 check(truncated in (0, 1)),\n        retry_count integer not null default 0,\n        retryable integer not null default 0 check(retryable in (0, 1)),\n        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),\n        error_type text,\n        error_code text,\n        error_message text\n      )",
  // ---- table session_input
  "CREATE TABLE session_input (\n        id text primary key,\n        session_id text not null references session(id) on delete cascade,\n        kind text not null,\n        delivery text not null check(delivery in ('startNow', 'guide', 'queue')),\n        payload text not null,\n        admitted_sequence integer not null,\n        promoted_sequence integer,\n        promoted_message_id text,\n        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded', 'failed')),\n        status_reason text,\n        time_created integer not null,\n        time_updated integer not null\n      )",
  // ---- index session_project_idx
  "CREATE INDEX session_project_idx on session(project_id)",
  // ---- index session_workspace_idx
  "CREATE INDEX session_workspace_idx on session(workspace_id)",
  // ---- index session_parent_idx
  "CREATE INDEX session_parent_idx on session(parent_id)",
  // ---- index message_session_time_created_id_idx
  "CREATE INDEX message_session_time_created_id_idx\n        on message(session_id, time_created, id)",
  // ---- index part_message_id_id_idx
  "CREATE INDEX part_message_id_id_idx on part(message_id, id)",
  // ---- index part_session_idx
  "CREATE INDEX part_session_idx on part(session_id)",
  // ---- index todo_session_idx
  "CREATE INDEX todo_session_idx on todo(session_id)",
  // ---- index session_entry_session_idx
  "CREATE INDEX session_entry_session_idx on session_entry(session_id)",
  // ---- index session_entry_session_type_idx
  "CREATE INDEX session_entry_session_type_idx on session_entry(session_id, type)",
  // ---- index session_entry_time_created_idx
  "CREATE INDEX session_entry_time_created_idx on session_entry(time_created)",
  // ---- index input_history_project_time_idx
  "CREATE INDEX input_history_project_time_idx\n        on input_history(project_id, time_created desc, id desc)",
  // ---- index input_history_time_idx
  "CREATE INDEX input_history_time_idx\n        on input_history(time_created desc, id desc)",
  // ---- index local_setting_scope_idx
  "CREATE INDEX local_setting_scope_idx\n        on local_setting(scope, scope_id)",
  // ---- index local_setting_namespace_key_idx
  "CREATE INDEX local_setting_namespace_key_idx\n        on local_setting(namespace, key)",
  // ---- index session_task_type_idx
  "CREATE INDEX session_task_type_idx on session(task_type)",
  // ---- index workflow_definition_source_idx
  "CREATE INDEX workflow_definition_source_idx\n        on workflow_definition(source, enabled)",
  // ---- index workflow_run_parent_session_idx
  "CREATE INDEX workflow_run_parent_session_idx\n        on workflow_run(parent_session_id)",
  // ---- index workflow_run_cwd_status_idx
  "CREATE INDEX workflow_run_cwd_status_idx\n        on workflow_run(cwd, status, time_updated desc)",
  // ---- index workflow_run_definition_idx
  "CREATE INDEX workflow_run_definition_idx\n        on workflow_run(definition_id)",
  // ---- index workflow_activity_run_status_idx
  "CREATE INDEX workflow_activity_run_status_idx\n        on workflow_activity(run_id, status, call_index)",
  // ---- index workflow_activity_child_session_idx
  "CREATE INDEX workflow_activity_child_session_idx\n        on workflow_activity(child_session_id)",
  // ---- index workflow_event_run_sequence_idx
  "CREATE INDEX workflow_event_run_sequence_idx\n        on workflow_event(run_id, sequence)",
  // ---- index session_task_link_root_workflow_idx
  "CREATE INDEX session_task_link_root_workflow_idx\n        on session_task_link(root_workflow_run_id, depth, path)",
  // ---- index session_task_link_parent_idx
  "CREATE INDEX session_task_link_parent_idx\n        on session_task_link(parent_link_id)",
  // ---- index session_task_link_activity_idx
  "CREATE INDEX session_task_link_activity_idx\n        on session_task_link(activity_id)",
  // ---- index model_usage_started_model_idx
  "CREATE INDEX model_usage_started_model_idx\n        on model_usage(started_at, provider_id, model_id)",
  // ---- index model_usage_session_turn_idx
  "CREATE INDEX model_usage_session_turn_idx\n        on model_usage(session_id, turn_id)",
  // ---- index model_usage_trace_idx
  "CREATE INDEX model_usage_trace_idx\n        on model_usage(trace_id)",
  // ---- index model_usage_query_source_idx
  "CREATE INDEX model_usage_query_source_idx\n        on model_usage(query_source)",
  // ---- index turn_usage_started_idx
  "CREATE INDEX turn_usage_started_idx\n        on turn_usage(started_at)",
  // ---- index tool_usage_session_tool_call_idx
  "CREATE UNIQUE INDEX tool_usage_session_tool_call_idx\n        on tool_usage(session_id, tool_call_id)",
  // ---- index tool_usage_started_tool_idx
  "CREATE INDEX tool_usage_started_tool_idx\n        on tool_usage(started_at, tool_name)",
  // ---- index tool_usage_session_turn_idx
  "CREATE INDEX tool_usage_session_turn_idx\n        on tool_usage(session_id, turn_id)",
  // ---- index session_trace_idx
  "CREATE INDEX session_trace_idx on session(trace_id)",
  // ---- index message_session_sequence_idx
  "CREATE INDEX message_session_sequence_idx\n        on message(session_id, sequence, time_created, id)",
  // ---- index part_message_sequence_idx
  "CREATE INDEX part_message_sequence_idx\n        on part(message_id, sequence, time_created, id)",
  // ---- index part_session_message_sequence_idx
  "CREATE INDEX part_session_message_sequence_idx\n        on part(session_id, message_id, sequence)",
  // ---- index session_input_session_admitted_idx
  "CREATE INDEX session_input_session_admitted_idx\n        on session_input(session_id, admitted_sequence)",
  // ---- index session_input_session_status_idx
  "CREATE INDEX session_input_session_status_idx\n        on session_input(session_id, status)",
  // ---- trigger message_sequence_autofill
  "CREATE TRIGGER message_sequence_autofill\n      after insert on message\n      when new.sequence is null\n      begin\n        update message\n        set sequence = (\n          select coalesce(max(sequence), -1) + 1\n          from message\n          where session_id = new.session_id\n        )\n        where id = new.id;\n      end",
  // ---- trigger part_sequence_autofill
  "CREATE TRIGGER part_sequence_autofill\n      after insert on part\n      when new.sequence is null\n      begin\n        update part\n        set sequence = (\n          select coalesce(max(sequence), -1) + 1\n          from part\n          where message_id = new.message_id\n        )\n        where id = new.id;\n      end",
];

/** zcode 的迁移账本：建库后原样写入，让 zcode 认为所有迁移都已应用。 */
export interface ZcodeMigrationRow {
  id: string;
  checksum: string;
  app_version: string;
  time_applied: number;
}

export const ZCODE_MIGRATIONS: ZcodeMigrationRow[] = [
  { id: "0001_base_session_store", checksum: "60e2d6a38ab36f31417c4f92c02690c96c7dcaaa0b6abe1741117d62a55c6462", app_version: "0.2.0", time_applied: 1786941066899 },
  { id: "0002_local_setting", checksum: "22a6ada9325c9ad55a00a1f0ecf72332c63c1e89fc3d91fec8d155bb0058b465", app_version: "0.2.0", time_applied: 1786941066900 },
  { id: "0003_backfill_permission_local_setting", checksum: "bd880375ba7b948c8bcda847e7eb52bc568d065bcba48190f6c3bfb14d11b7dc", app_version: "0.2.0", time_applied: 1786941066900 },
  { id: "0004_session_target", checksum: "df670752991c78e38e2f25b0a003abc0e9689bc8d4894351358f2f83335a3ae1", app_version: "0.7.0", time_applied: 1786941066900 },
  { id: "0005_session_target_accounting", checksum: "6138ed4562dfdd5b571d39d3b62266c55dd9eb8f2f41948e046441a0e4a954cc", app_version: "0.7.0", time_applied: 1786941066902 },
  { id: "0006_input_history_attachments", checksum: "a2eab98649d738e15bdae27de7c5c114713f7777c55aa4111b19e03ee5ced54f", app_version: "0.11.0", time_applied: 1786941066902 },
  { id: "0007_workflow_script_runtime", checksum: "0068fc4bcaffe4de4669442a62eee227726e0e8e81b61c7458213a20ac596009", app_version: "0.13.0", time_applied: 1786941066904 },
  { id: "0008_workflow_definition_scope", checksum: "f7ee304e4005c291fb8883cfc180005263e6c6b2f94077487443f2c17a71d3eb", app_version: "0.13.0", time_applied: 1786941066905 },
  { id: "0009_session_title_metadata", checksum: "3855cf957177ae6319ae91866cdff59e946ca07a10b36b5b59689818bd13fe00", app_version: "0.14.0", time_applied: 1786941066906 },
  { id: "0010_usage_observability", checksum: "36918b0a98f465fe844097aa60c65ef73ea9c62cc266f02742bf3fc2cedf860b", app_version: "0.15.0", time_applied: 1786941066908 },
  { id: "0011_session_target_summary_title", checksum: "2b7723479426a4e7a1ed9901ed817495c1bbf63e9547eb1c63cd9e24bf9305f8", app_version: "0.15.0", time_applied: 1786941066908 },
  { id: "0012_session_trace_id", checksum: "9dcef90998dd00c8ed1b22a2170e180eb15471b93947e65ebe101d41e96bdb60", app_version: "0.15.0", time_applied: 1786941066909 },
  { id: "0013_session_target_active_run_accounting", checksum: "7ab185540ebb7d26c5403ca52a50de6cf161c79cb93ccd47ff1b43b87415fe1c", app_version: "0.15.0", time_applied: 1786941066911 },
  { id: "0014_message_part_sequence", checksum: "66b45c45e4d3a1a60829f193f38d865dcdbd3de2eb78aa79ba954fe7ef1aab08", app_version: "0.15.0", time_applied: 1786941066913 },
  { id: "0015_message_part_sequence_backfill_and_guard", checksum: "da3046bf061ebb5ba253bb772f0fc9e4d1f2856dac4cdbc4cc0a65aae00e8511", app_version: "0.15.2", time_applied: 1786941066914 },
  { id: "0016_session_input_ledger", checksum: "18d51ae3f5e1425dc1e5c809282129fdc7430cacb6b1ce517b412ddbc34be790", app_version: "0.15.2", time_applied: 1786941066914 },
  { id: "0017_session_input_start_now_delivery", checksum: "8c2da5985ecdf342438a2df713c9e18114276a0e85ce6f2e4f79bdf1596b52f8", app_version: "0.15.2", time_applied: 1786941066917 },
  { id: "0018_session_input_failed_status", checksum: "a4d1a7b7c5d4af426b695769ed0f3a031efac8aa7af1f6412a85292c42b5d15b", app_version: "0.15.2", time_applied: 1786941066920 },
];
