"""BACnet Profile Automation Agent - Main Entry Point.

A deterministic workflow using LangGraph for sequential profile generation.
"""

import argparse
import json
import logging
import sys
from pathlib import Path

from agent.config import TEMP_ROOT_DIR
from agent.context import WorkflowContext
from agent.nodes.parse import parse_issue_node
from agent.nodes.validate import validate_profile_node
from agent.nodes.test_gen import generate_tests_node
from agent.nodes.changelog import generate_changelog_node
from agent.nodes.merge import merge_results_node
from agent.workflow import build_workflow

logger = logging.getLogger(__name__)


def main() -> int:
    """Main entry point."""
    args = _parse_arguments()
    ctx = _initialize_context(args.issue_number)

    try:
        result = _run_workflow(args.issue_body_file, args.issue_number, ctx)
        _save_result(result, ctx, args.issue_number)
        return 0 if result["success"] else 1
    except Exception as e:
        logger.error(f"Workflow failed: {e}", exc_info=True)
        return 1


def _parse_arguments() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="BACnet Profile Automation Agent (LangGraph)"
    )
    parser.add_argument(
        "--issue-body-file", required=True, help="Path to issue body text file"
    )
    parser.add_argument(
        "--issue-number", type=int, required=True, help="GitHub Issue number"
    )
    return parser.parse_args()


def _initialize_context(issue_number: int) -> WorkflowContext:
    """Initialize workflow context and logging."""
    ctx = WorkflowContext()
    ctx.setup(issue_number)
    _setup_logging(ctx.run_dir / "agent.log")
    return ctx


def _setup_logging(log_file: Path) -> None:
    """Setup logging configuration."""
    root_logger = logging.getLogger()
    for handler in list(root_logger.handlers):
        root_logger.removeHandler(handler)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[
            logging.FileHandler(log_file, mode="w", encoding="utf-8"),
            logging.StreamHandler(sys.stdout),
        ],
    )


def _run_workflow(
    issue_body_file: str, issue_number: int, ctx: WorkflowContext
) -> dict:
    """Execute the workflow."""
    issue_body = Path(issue_body_file).read_text(encoding="utf-8")
    initial_state = _create_initial_state(issue_body, issue_number)

    node_functions = {
        "parse": parse_issue_node,
        "validate": validate_profile_node,
        "test_gen": generate_tests_node,
        "changelog": generate_changelog_node,
        "merge": merge_results_node,
    }

    logger.info("Building LangGraph workflow...")
    app = build_workflow(node_functions, ctx)

    logger.info("Starting workflow execution...")
    final_state = app.invoke(initial_state)

    return _extract_result(final_state)


def _create_initial_state(issue_body: str, issue_number: int) -> dict:
    """Create initial workflow state."""
    return {
        "issue_body": issue_body,
        "issue_number": issue_number,
        "parsed_data": None,
        "devices": [],
        "all_generated_files": [],
        "errors": [],
        "messages": [],
    }


def _extract_result(final_state: dict) -> dict:
    """Extract result from final state."""
    success = len(final_state.get("errors", [])) == 0
    generated_files = final_state.get("all_generated_files", [])

    logger.info(f"Workflow completed - Generated {len(generated_files)} files")

    for file_path in generated_files:
        logger.info(f"  - {file_path}")

    if final_state.get("errors"):
        logger.warning(f"Errors: {len(final_state['errors'])}")

    return {
        "success": success,
        "generated_files": generated_files,
        "errors": final_state.get("errors", []),
    }


def _save_result(result: dict, ctx: WorkflowContext, issue_number: int) -> None:
    """Save workflow result to file."""
    result_file = ctx.run_dir / f"agent-result-{issue_number}.json"
    result_data = {
        "issue_number": issue_number,
        "success": result["success"],
        "generated_files": result["generated_files"],
        "errors": result["errors"],
    }
    result_file.write_text(
        json.dumps(result_data, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    logger.info(f"Result saved to: {result_file}")


if __name__ == "__main__":
    sys.exit(main())
