/**
 * Human-friendly, action-style labels for agent tools.
 *
 * The backend tool names are snake_case identifiers (e.g. `generate_nfr_tests`).
 * The UI shows these labels instead (e.g. "Generating NFR tests") so a
 * non-technical audience can follow what the agent is doing. The raw tool
 * name is still surfaced on the expanded tool card for transparency.
 */
const TOOL_LABELS: Record<string, string> = {
  // Workspace / filesystem
  read_file: "Reading file",
  batch_read_files: "Reading files",
  write_file: "Writing file",
  code_edit: "Editing code",
  grep_search: "Searching code",
  file_search: "Finding files",
  list_directory: "Listing folder",
  workspace_tree: "Mapping workspace",
  create_entry: "Creating file",
  delete_entry: "Deleting file",
  rename_entry: "Renaming file",
  run_terminal: "Running command",

  // Human-in-the-loop
  ask_user: "Asking you a question",
  request_approval: "Requesting your approval",
  manage_plan: "Updating the plan",
  remember: "Saving to memory",

  // Attachments
  list_attachments: "Listing attachments",
  read_attachment: "Reading attachment",

  // Connectors
  jira_fetch_issue: "Fetching Jira issue",
  jira_search: "Searching Jira",
  jira_hierarchy: "Reading Jira hierarchy",
  confluence_fetch_page: "Fetching Confluence page",
  confluence_search: "Searching Confluence",
  confluence_page_extract: "Reading Confluence page",
  web_fetch: "Fetching web page",

  // Knowledge / vector store
  index_document: "Indexing document",
  search_semantic: "Searching knowledge base",
  list_indexed_sources: "Listing indexed sources",

  // QA layer
  analyze_requirements: "Analyzing requirements",
  write_artefact: "Writing artefact",
  generate_gherkin: "Generating Gherkin scenarios",
  generate_test_cases: "Generating test cases",
  generate_automation: "Generating automation",
  generate_nfr_tests: "Generating NFR tests",
  execute_tests: "Running tests",
  build_traceability_matrix: "Building traceability matrix",
  export_test_cases: "Exporting test cases",
};

/** Friendly label for a tool name, falling back to a prettified identifier. */
export function toolLabel(name: string): string {
  if (!name) return "Working";
  const known = TOOL_LABELS[name];
  if (known) return known;
  return name
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
