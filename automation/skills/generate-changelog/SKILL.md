---
name: generate-changelog
description: Create a standard Keep a Changelog entry for profile updates
---

# Generate Changelog Skill

## Instructions

### Step 1: Comparison
1. If the profile already existed, call `run_diff(old_path, new_path)` to see changes.

### Step 2: Write Entry
1. Draft entry in "Keep a Changelog" format (Added, Changed, Fixed).
2. Call `save_and_register("/profiles/{vendor}/CHANGELOG.md", content)`. (Append if exists).
