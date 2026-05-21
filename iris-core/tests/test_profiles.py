from __future__ import annotations

import base64
from pathlib import Path

import pytest

from hermes_management_server.runtime_adapters import hermes_store
from hermes_management_server.runtime_adapters.hermes_store import (
    HermesStore,
    content_hash,
    decode_skill_id,
    encode_skill_id,
    gateway_running,
    normalized_memory_file_key,
    skill_entrypoint_paths,
    normalize_hermes_home,
    normalize_profile_name,
    validate_profile_name,
)
from hermes_management_server.security import ManagementError


def test_normalize_hermes_home_from_profile_path(tmp_path):
    root = tmp_path / ".hermes"
    profile = root / "profiles" / "work"

    assert normalize_hermes_home(str(profile)) == root


def test_profile_discovery_reads_summary(tmp_path):
    root = tmp_path / ".hermes"
    default_memories = root / "memories"
    default_memories.mkdir(parents=True)
    (default_memories / "MEMORY.md").write_text("default memory", encoding="utf-8")
    (root / "active_profile").write_text("work", encoding="utf-8")

    work = root / "profiles" / "work"
    (work / "skills" / "ops" / "deploy").mkdir(parents=True)
    (work / "skills" / "ops" / "deploy" / "SKILL.md").write_text("# Deploy\n", encoding="utf-8")
    (work / "config.yaml").write_text(
        "model:\n  provider: openai\n  model: gpt-5.4\n",
        encoding="utf-8",
    )

    store = HermesStore(root)
    profiles = {profile.name: profile for profile in store.profiles()}

    assert list(profiles) == ["default", "work"]
    assert profiles["work"].active is True
    assert profiles["work"].provider == "openai"
    assert profiles["work"].model == "gpt-5.4"
    assert profiles["work"].skillCount == 1
    assert profiles["default"].memoryBytes == len("default memory")


def test_gateway_running_uses_windows_process_probe_without_signal(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / "gateway.pid").write_text('{"pid": 12345, "kind": "hermes-gateway"}', encoding="utf-8")

    monkeypatch.setattr(hermes_store, "is_windows", lambda: True)
    monkeypatch.setattr(hermes_store, "windows_pid_running", lambda pid: pid == 12345)

    def fail_if_called(_pid, _signal):
        raise AssertionError("os.kill must not be used as a Windows PID probe")

    monkeypatch.setattr(hermes_store.os, "kill", fail_if_called)

    assert gateway_running(root) is True


def test_memory_reads_memory_and_user_files(tmp_path):
    root = tmp_path / ".hermes"
    memories = root / "profiles" / "work" / "memories"
    memories.mkdir(parents=True)
    (memories / "MEMORY.md").write_text("memory content", encoding="utf-8")
    (memories / "USER.md").write_text("user content", encoding="utf-8")

    memory, user = HermesStore(root).memory_files("work")

    assert memory.name == "MEMORY.md"
    assert memory.content == "memory content"
    assert memory.contentHash == content_hash("memory content")
    assert user.name == "USER.md"
    assert user.content == "user content"
    assert user.contentHash == content_hash("user content")


def test_memory_file_key_normalization_accepts_supported_files():
    assert normalized_memory_file_key("memory") == "memory"
    assert normalized_memory_file_key("MEMORY.md") == "memory"
    assert normalized_memory_file_key("user") == "user"
    assert normalized_memory_file_key("USER.md") == "user"


def test_memory_file_key_normalization_rejects_other_files():
    with pytest.raises(ManagementError):
        normalized_memory_file_key("profile.yaml")


def test_skill_discovery_and_detail_use_safe_ids(tmp_path):
    root = tmp_path / ".hermes"
    skill = root / "profiles" / "work" / "skills" / "ops" / "deploy" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text(
        "---\nname: Deploy Helper\ndescription: Helps deploy Hermes safely.\ntags: deploy,ops\nversion: 1.2.3\n---\n\nBody",
        encoding="utf-8",
    )

    store = HermesStore(root)
    skills = store.skills("work")
    summary = skills[0]
    detail, content = store.skill_detail("work", summary.id)

    assert summary.id == encode_skill_id(skill.relative_to(root / "profiles" / "work" / "skills"))
    assert summary.name == "Deploy Helper"
    assert summary.description == "Helps deploy Hermes safely."
    assert summary.tags == ["deploy", "ops"]
    assert detail.path == str(skill)
    assert content.endswith("Body")


def test_skill_discovery_skips_deep_assets_and_symlinks(tmp_path):
    root = tmp_path / ".hermes"
    profile_root = root / "profiles" / "work"
    skills = profile_root / "skills"
    good = skills / "ops" / "deploy" / "SKILL.md"
    deep_asset = skills / "ops" / "deploy" / "node_modules" / "nested" / "SKILL.md"
    good.parent.mkdir(parents=True)
    deep_asset.parent.mkdir(parents=True)
    good.write_text("# Deploy\n", encoding="utf-8")
    deep_asset.write_text("# Should not be scanned\n", encoding="utf-8")
    (skills / "ops" / "loop").symlink_to(skills / "ops", target_is_directory=True)

    paths = skill_entrypoint_paths(skills, profile_root)

    assert paths == [good]


def test_profile_name_rejects_traversal():
    with pytest.raises(ManagementError):
        validate_profile_name("../bad")


def test_profile_name_normalizes_and_rejects_non_canonical():
    assert normalize_profile_name("Research_Team") == "research_team"
    with pytest.raises(ManagementError):
        validate_profile_name("Research")
    with pytest.raises(ManagementError):
        validate_profile_name("research.team")
    with pytest.raises(ManagementError):
        validate_profile_name("sudo")


def test_create_profile_scaffolds_expected_directories_and_soul(tmp_path):
    root = tmp_path / ".hermes"
    profile, warnings = HermesStore(root).create_profile("Research")

    assert profile.name == "research"
    assert isinstance(warnings, list)
    for relative in ("memories", "sessions", "skills", "skins", "logs", "plans", "workspace", "cron", "home"):
        assert (root / "profiles" / "research" / relative).is_dir()
    assert (root / "profiles" / "research" / "SOUL.md").read_text(encoding="utf-8")


def test_activate_default_removes_active_profile(tmp_path):
    root = tmp_path / ".hermes"
    (root / "profiles" / "work").mkdir(parents=True)
    store = HermesStore(root)

    store.activate_profile("work")
    assert (root / "active_profile").read_text(encoding="utf-8") == "work"
    store.activate_profile("default")

    assert not (root / "active_profile").exists()


def test_clone_identity_copies_identity_without_runtime_state(tmp_path):
    root = tmp_path / ".hermes"
    source = root
    (source / "memories").mkdir(parents=True)
    (source / "skills" / "ops" / "deploy").mkdir(parents=True)
    (source / "sessions").mkdir()
    (source / "logs").mkdir()
    (source / "profiles" / "sibling").mkdir(parents=True)
    (source / "config.yaml").write_text("model: gpt-5.5\n", encoding="utf-8")
    (source / ".env").write_text("SECRET=value\n", encoding="utf-8")
    (source / "SOUL.md").write_text("soul", encoding="utf-8")
    (source / "memories" / "MEMORY.md").write_text("memory", encoding="utf-8")
    (source / "skills" / "ops" / "deploy" / "SKILL.md").write_text("# Deploy\n", encoding="utf-8")
    (source / "sessions" / "session.json").write_text("{}", encoding="utf-8")
    (source / "state.db").write_text("state", encoding="utf-8")
    (source / "gateway.pid").write_text('{"pid": 999999}', encoding="utf-8")

    HermesStore(root).clone_profile("default", "copy")
    target = root / "profiles" / "copy"

    assert (target / "config.yaml").read_text(encoding="utf-8") == "model: gpt-5.5\n"
    assert (target / ".env").read_text(encoding="utf-8") == "SECRET=value\n"
    assert (target / "SOUL.md").read_text(encoding="utf-8") == "soul"
    assert (target / "memories" / "MEMORY.md").read_text(encoding="utf-8") == "memory"
    assert (target / "skills" / "ops" / "deploy" / "SKILL.md").is_file()
    assert not (target / "sessions" / "session.json").exists()
    assert not (target / "state.db").exists()
    assert not (target / "gateway.pid").exists()
    assert not (target / "profiles").exists()


def test_clone_all_strips_gateway_runtime_files_and_sibling_profiles(tmp_path):
    root = tmp_path / ".hermes"
    (root / "profiles" / "sibling").mkdir(parents=True)
    (root / "sessions").mkdir(parents=True)
    (root / "sessions" / "session.json").write_text("{}", encoding="utf-8")
    (root / "gateway.pid").write_text("123", encoding="utf-8")
    (root / "gateway_state.json").write_text("{}", encoding="utf-8")

    HermesStore(root).clone_profile("default", "full", clone_mode="all")
    target = root / "profiles" / "full"

    assert (target / "sessions" / "session.json").is_file()
    assert not (target / "gateway.pid").exists()
    assert not (target / "gateway_state.json").exists()
    assert not (target / "profiles").exists()


def test_skill_id_rejects_traversal():
    bad = base64.urlsafe_b64encode(b"../secret/SKILL.md").decode("ascii").rstrip("=")

    with pytest.raises(ManagementError):
        decode_skill_id(bad)


def test_install_skill_preserves_source_content_and_relative_path(tmp_path):
    root = tmp_path / ".hermes"
    relative = Path("research") / "summarize" / "SKILL.md"
    source = root / "skills" / relative
    source.parent.mkdir(parents=True)
    source_content = "---\nname: Summarize\n---\n\nNo trailing newline"
    source.write_text(source_content, encoding="utf-8")
    (root / "profiles" / "health").mkdir(parents=True)

    summary, content = HermesStore(root).install_skill(
        "health",
        {
            "sourceProfile": "default",
            "sourceSkillId": encode_skill_id(relative),
        },
    )
    target = root / "profiles" / "health" / "skills" / relative

    assert summary.id == encode_skill_id(relative)
    assert content == source_content
    assert target.read_text(encoding="utf-8") == source_content


def test_delete_skill_prunes_empty_categories_but_keeps_skills_root(tmp_path):
    root = tmp_path / ".hermes"
    relative = Path("ops") / "deploy" / "SKILL.md"
    skill = root / "profiles" / "work" / "skills" / relative
    asset = skill.parent / "README.md"
    asset.parent.mkdir(parents=True)
    skill.write_text("# Deploy\n", encoding="utf-8")
    asset.write_text("asset notes", encoding="utf-8")

    result = HermesStore(root).delete_skill("work", encode_skill_id(relative))

    assert result["deletedSkillId"] == encode_skill_id(relative)
    assert not skill.parent.exists()
    assert not (root / "profiles" / "work" / "skills" / "ops").exists()
    assert (root / "profiles" / "work" / "skills").is_dir()


def test_profile_file_allowlist_hash_conflict_and_env_redaction(tmp_path):
    root = tmp_path / ".hermes"
    profile = root / "profiles" / "work"
    profile.mkdir(parents=True)
    (profile / "SOUL.md").write_text("before", encoding="utf-8")
    (profile / "config.yaml").write_text(
        "model:\n  provider: openai-codex\n  default: gpt-5.5\n",
        encoding="utf-8",
    )
    (profile / ".env").write_text("API_KEY=secret\n", encoding="utf-8")
    store = HermesStore(root)

    identity = store.profile_identity("work")
    assert identity["soul"]["content"] == "before"
    assert identity["config"]["provider"] == "openai-codex"
    assert identity["config"]["model"] == "gpt-5.5"
    assert identity["env"]["keys"] == ["API_KEY"]
    assert "secret" not in str(identity["env"])
    with pytest.raises(ManagementError):
        store.read_profile_file("work", "../auth.json")
    with pytest.raises(ManagementError):
        store.read_profile_file("work", ".env")
    with pytest.raises(ManagementError):
        store.write_profile_file("work", "SOUL.md", "after", "bad-hash")

    updated_env = store.update_profile_env("work", {"NEW_SECRET": "value"}, [])
    assert updated_env["keys"] == ["API_KEY", "NEW_SECRET"]
    assert "value" not in str(updated_env)
    assert "NEW_SECRET=value" in (profile / ".env").read_text(encoding="utf-8")


def test_config_parse_error_is_returned_not_raised(tmp_path):
    root = tmp_path / ".hermes"
    profile = root / "profiles" / "work"
    profile.mkdir(parents=True)
    (profile / "config.yaml").write_text("model: [unterminated\n", encoding="utf-8")

    result = HermesStore(root).profile_config("work")

    assert result["ok"] is True
    assert result["raw"] == "model: [unterminated\n"
    assert "parseError" in result


def test_export_excludes_credentials_and_import_rejects_unsafe_members(tmp_path):
    import tarfile

    root = tmp_path / ".hermes"
    profile = root / "profiles" / "work"
    profile.mkdir(parents=True)
    (profile / "SOUL.md").write_text("safe", encoding="utf-8")
    (profile / ".env").write_text("SECRET=value\n", encoding="utf-8")
    (profile / "auth.json").write_text("{}", encoding="utf-8")
    archive = tmp_path / "work.tar.gz"

    exported = HermesStore(root).export_profile("work", archive)
    with tarfile.open(exported, "r:gz") as tar:
        names = set(tar.getnames())
    assert "work/SOUL.md" in names
    assert "work/.env" not in names
    assert "work/auth.json" not in names

    unsafe = tmp_path / "unsafe.tar.gz"
    payload = tmp_path / "payload.txt"
    payload.write_text("bad", encoding="utf-8")
    with tarfile.open(unsafe, "w:gz") as tar:
        tar.add(payload, arcname="../escape.txt")
    with pytest.raises(ManagementError):
        HermesStore(root).import_profile(unsafe, "imported")


def test_distribution_install_update_preserves_user_owned_paths(tmp_path):
    source = tmp_path / "dist"
    (source / "skills" / "ops").mkdir(parents=True)
    (source / "memories").mkdir()
    (source / "distribution.yaml").write_text(
        "name: telemetry\nversion: 1.0.0\nenv_requires:\n  - name: API_KEY\n    required: true\n",
        encoding="utf-8",
    )
    (source / "SOUL.md").write_text("v1", encoding="utf-8")
    (source / "skills" / "ops" / "SKILL.md").write_text("# Ops v1\n", encoding="utf-8")
    (source / "memories" / "MEMORY.md").write_text("distribution memory", encoding="utf-8")
    root = tmp_path / ".hermes"
    store = HermesStore(root)

    profile, details, _warnings = store.install_distribution(source=str(source), name="installed")
    target = root / "profiles" / "installed"
    (target / ".env").write_text("SECRET=user\n", encoding="utf-8")
    (target / "memories" / "MEMORY.md").write_text("user memory", encoding="utf-8")
    (source / "SOUL.md").write_text("v2", encoding="utf-8")
    (source / "skills" / "ops" / "SKILL.md").write_text("# Ops v2\n", encoding="utf-8")
    (source / "distribution.yaml").write_text("name: telemetry\nversion: 2.0.0\n", encoding="utf-8")
    result = store.update_distribution("installed")

    assert profile.name == "installed"
    assert "SOUL.md" in details["changedPaths"]
    assert (target / "SOUL.md").read_text(encoding="utf-8") == "v2"
    assert (target / "skills" / "ops" / "SKILL.md").read_text(encoding="utf-8") == "# Ops v2\n"
    assert (target / "memories" / "MEMORY.md").read_text(encoding="utf-8") == "user memory"
    assert (target / ".env").read_text(encoding="utf-8") == "SECRET=user\n"
    assert result["distribution"]["version"] == "2.0.0"


def test_alias_collision_and_remove(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    (root / "profiles" / "work").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("PATH", str(tmp_path))

    status = HermesStore(root).create_alias("work")
    removed = HermesStore(root).remove_alias("work")

    assert status["exists"] is True
    assert status["alias"] == "work"
    assert removed["exists"] is False
