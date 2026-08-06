'use strict';

const LABELS = {
  'profile:ready': { color: '0E8A16', description: 'Ready for Profile Automation generation' },
  'profile:needs-info': { color: 'FBCA04', description: 'Submitter must edit the original Issue' },
  'profile:manual': { color: 'D93F0B', description: 'Outside Profile Automation scope' },
  'profile:generating': { color: '1D76DB', description: 'Profile Automation is generating a candidate' },
  'profile:blocked': { color: 'B60205', description: 'Profile Automation stopped after three attempts' },
  'profile:review': { color: '5319E7', description: 'Draft PR awaits maintainer review' },
  'profile:generated': { color: '0E8A16', description: 'Profile was merged' },
  'profile:unverified': { color: 'C2E0C6', description: 'Not verified on real hardware' }
};

class GitHubClient {
  constructor(repo, token) {
    if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
    this.repo = repo;
    this.token = token;
  }

  async request(method, endpoint, body) {
    const response = await fetch(`https://api.github.com/repos/${this.repo}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      throw new Error(`GitHub API ${method} ${endpoint} failed with HTTP ${response.status}: ${detail}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  getIssue(number) {
    return this.request('GET', `/issues/${number}`);
  }

  async ensureLabel(name) {
    const definition = LABELS[name];
    if (!definition) throw new Error(`Unknown automation label: ${name}`);
    try {
      await this.request('GET', `/labels/${encodeURIComponent(name)}`);
    } catch (error) {
      if (!/HTTP 404/.test(error.message)) throw error;
      try {
        await this.request('POST', '/labels', { name, ...definition });
      } catch (createError) {
        if (!/HTTP 422/.test(createError.message)) throw createError;
      }
    }
  }

  async setStateLabels(issueNumber, activeLabel) {
    const stateLabels = Object.keys(LABELS).filter(label => label !== 'profile:unverified');
    await this.ensureLabel(activeLabel);
    const issue = await this.getIssue(issueNumber);
    const current = (issue.labels || []).map(label => typeof label === 'string' ? label : label.name);
    const retained = current.filter(label => !stateLabels.includes(label) || label === activeLabel);
    if (!retained.includes(activeLabel)) retained.push(activeLabel);
    await this.request('POST', `/issues/${issueNumber}/labels`, { labels: retained });
  }

  async addLabels(issueNumber, labels) {
    for (const label of labels) await this.ensureLabel(label);
    return this.request('POST', `/issues/${issueNumber}/labels`, { labels });
  }

  async removeLabel(issueNumber, label) {
    try {
      return await this.request('DELETE', `/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
    } catch (error) {
      if (/HTTP 404/.test(error.message)) return null;
      throw error;
    }
  }

  async upsertComment(issueNumber, marker, body) {
    const comments = await this.request('GET', `/issues/${issueNumber}/comments?per_page=100`);
    const existing = comments.find(comment => String(comment.body || '').includes(marker) && comment.user && comment.user.type === 'Bot');
    const content = `${marker}\n${body}`;
    if (existing) return this.request('PATCH', `/issues/comments/${existing.id}`, { body: content });
    return this.request('POST', `/issues/${issueNumber}/comments`, { body: content });
  }

  async collaboratorPermission(username) {
    try {
      const result = await this.request('GET', `/collaborators/${encodeURIComponent(username)}/permission`);
      return result.permission;
    } catch (error) {
      if (/HTTP 404/.test(error.message)) return 'none';
      throw error;
    }
  }

  async closeIssue(issueNumber) {
    return this.request('PATCH', `/issues/${issueNumber}`, { state: 'closed', state_reason: 'completed' });
  }

  async dispatchWorkflow(workflow, ref) {
    return this.request('POST', `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref });
  }
}

module.exports = { GitHubClient, LABELS };
