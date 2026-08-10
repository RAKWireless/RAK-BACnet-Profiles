'use strict';

const INTERNAL_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function labelNames(issue) {
  return (issue.labels || []).map(label => String(typeof label === 'string' ? label : label.name || ''));
}

function isInternal(issue) {
  return INTERNAL_ASSOCIATIONS.has(String(issue.author_association || '').toUpperCase());
}

function decideIntake(intake, issue, event = {}, enabled = true) {
  if (intake.status === 'ignored') return { state: 'ignored', shouldRun: false, trust: 'none' };
  if (intake.status === 'needs-info') return { state: 'needs-info', shouldRun: false, trust: isInternal(issue) ? 'internal' : 'external' };
  if (intake.status === 'manual' || intake.status === 'duplicate') {
    return { state: 'manual', shouldRun: false, trust: isInternal(issue) ? 'internal' : 'external' };
  }

  const trust = isInternal(issue) ? 'internal' : 'external';
  const edited = event.action === 'edited';
  const approvalEvent = event.action === 'labeled' && event.label && event.label.name === 'profile:approved';
  const approved = labelNames(issue).includes('profile:approved');
  const authorized = trust === 'internal' || (!edited && approvalEvent && approved);
  if (!authorized) {
    return { state: 'awaiting-approval', shouldRun: false, trust, consumeApproval: edited || approved };
  }
  return {
    state: 'queued',
    shouldRun: enabled,
    paused: !enabled,
    trust,
    consumeApproval: approved
  };
}

module.exports = { INTERNAL_ASSOCIATIONS, isInternal, decideIntake };
