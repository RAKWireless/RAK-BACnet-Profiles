"""
Workflow builder for LangGraph.

This module assembles the workflow graph by connecting nodes and edges.
LangGraph uses this definition to execute the workflow deterministically.

Context:
    - Called by: main.py (once at startup)
    - Creates: StateGraph that defines execution order
    - Pattern: Sequential with conditional retry loop

Workflow Structure:
    START
      ↓
    parse_issue (extract device info, generate profiles)
      ↓
    generate_tests (create test data)
      ↓
    validate_profile (check YAML syntax and logic)
      ↓
      ├─[failed & attempts<2]──→ parse_issue (retry loop)
      └─[passed or max retries]─→ generate_changelog
                                    ↓
                                  merge_results
                                    ↓
                                   END
"""

from langgraph.graph import StateGraph, START, END

from agent.state import OverallState
from agent.router import route_after_validate


def build_workflow(node_functions: dict, ctx) -> StateGraph:
    """Build the LangGraph workflow."""
    workflow = StateGraph(OverallState)

    _add_nodes(workflow, node_functions, ctx)
    _add_edges(workflow)

    return workflow.compile()


def _add_nodes(workflow: StateGraph, node_functions: dict, ctx) -> None:
    """Add all nodes to workflow."""
    workflow.add_node("parse_issue", lambda s: node_functions["parse"](s, ctx))
    workflow.add_node("validate_profile", lambda s: node_functions["validate"](s, ctx))
    workflow.add_node("generate_tests", lambda s: node_functions["test_gen"](s, ctx))
    workflow.add_node(
        "generate_changelog", lambda s: node_functions["changelog"](s, ctx)
    )
    workflow.add_node("merge_results", node_functions["merge"])


def _add_edges(workflow: StateGraph) -> None:
    """Add all edges to workflow."""
    workflow.add_edge(START, "parse_issue")
    workflow.add_edge("parse_issue", "generate_tests")
    workflow.add_edge("generate_tests", "validate_profile")
    workflow.add_conditional_edges(
        "validate_profile",
        route_after_validate,
        ["parse_issue", "generate_changelog"],
    )
    workflow.add_edge("generate_changelog", "merge_results")
    workflow.add_edge("merge_results", END)
