from __future__ import annotations

import base64

import pytest

from hermes_management_server.runtime_adapters.hermes_store import (
    HermesStore,
    decode_skill_id,
    encode_skill_id,
    skill_entrypoint_paths,
    normalize_hermes_home,
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


def test_memory_reads_memory_and_user_files(tmp_path):
    root = tmp_path / ".hermes"
    memories = root / "profiles" / "work" / "memories"
    memories.mkdir(parents=True)
    (memories / "MEMORY.md").write_text("memory content", encoding="utf-8")
    (memories / "USER.md").write_text("user content", encoding="utf-8")

    memory, user = HermesStore(root).memory_files("work")

    assert memory.name == "MEMORY.md"
    assert memory.content == "memory content"
    assert user.name == "USER.md"
    assert user.content == "user content"


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


def test_skill_id_rejects_traversal():
    bad = base64.urlsafe_b64encode(b"../secret/SKILL.md").decode("ascii").rstrip("=")

    with pytest.raises(ManagementError):
        decode_skill_id(bad)
