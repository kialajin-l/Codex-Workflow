# Schema Output Template

When the prompt asks for a JSON response, always return:

{
  "summary": "<one sentence describing what this task accomplished>",
  "changes": "<list of files or modules modified>",
  "risks": "<any risks or concerns, or 'none' if none>",
  "status": "ok"
}

Do not wrap in markdown fences. Return raw JSON only.
