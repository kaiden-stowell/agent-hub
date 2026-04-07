'use strict';
const fs   = require('fs');
const path = require('path');
const db   = require('./db');

const SKILLS_DIR = path.join(__dirname, 'skills');
if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });

// ── File helpers ─────────────────────────────────────────────────────────────
function skillFilePath(skillId) {
  return path.join(SKILLS_DIR, skillId + '.md');
}

function readSkillContent(skill) {
  try {
    if (skill.type === 'file') {
      // External file on disk
      return fs.readFileSync(skill.file_path, 'utf8');
    }
    if (skill.type === 'folder') {
      // Read all .md files in the folder
      const dir = skill.file_path;
      if (!fs.existsSync(dir)) return `(folder not found: ${dir})`;
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.md') || f.endsWith('.txt'))
        .sort();
      return files.map(f => {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        return `### ${f}\n\n${content}`;
      }).join('\n\n---\n\n');
    }
    // Inline skill — content stored in our skills/ dir
    const fp = skillFilePath(skill.id);
    return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
  } catch (e) {
    return `(could not read skill "${skill.name}": ${e.message})`;
  }
}

function writeSkillContent(skillId, content) {
  fs.writeFileSync(skillFilePath(skillId), content, 'utf8');
}

function deleteSkillFile(skillId) {
  const fp = skillFilePath(skillId);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

// ── Build injected context for an agent ──────────────────────────────────────
// Includes: skills owned by this agent + skills explicitly assigned to it (deduped)
function buildSkillsContext(agent) {
  const allSkills = db.getSkills();

  // Owned skills (private to this agent) — always included
  const ownedIds = new Set(
    allSkills.filter(s => s.owner_agent_id === agent.id).map(s => s.id)
  );

  // Explicitly assigned shared skills
  const assignedIds = new Set(agent.skill_ids || []);

  // Union, owned first
  const orderedIds = [
    ...ownedIds,
    ...[...assignedIds].filter(id => !ownedIds.has(id)),
  ];

  if (!orderedIds.length) return '';

  const parts = [];
  for (const sid of orderedIds) {
    const skill = db.getSkill(sid);
    if (!skill) continue;
    if (skill.active === false) continue; // not yet activated
    const content = readSkillContent(skill).trim();
    if (!content) continue;
    const label = skill.owner_agent_id ? `Private Skill: ${skill.name}` : `Shared Skill: ${skill.name}`;
    parts.push(`## ${label}\n\n${content}`);
  }
  if (!parts.length) return '';
  return `\n\n---\n# Skills & Knowledge\n\n${parts.join('\n\n---\n\n')}`;
}

// ── Scan disk for .md files the user can import ──────────────────────────────
function browseFiles(dirPath) {
  try {
    const resolved = path.resolve(dirPath);
    const entries  = fs.readdirSync(resolved, { withFileTypes: true });
    return entries.map(e => ({
      name:  e.name,
      path:  path.join(resolved, e.name),
      isDir: e.isDirectory(),
      isMd:  !e.isDirectory() && (e.name.endsWith('.md') || e.name.endsWith('.txt')),
      size:  e.isDirectory() ? null : fs.statSync(path.join(resolved, e.name)).size,
    })).filter(e => e.isDir || e.isMd);
  } catch {
    return [];
  }
}

module.exports = {
  readSkillContent,
  writeSkillContent,
  deleteSkillFile,
  buildSkillsContext,
  browseFiles,
  SKILLS_DIR,
};
