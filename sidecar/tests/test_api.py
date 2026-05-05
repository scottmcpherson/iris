from __future__ import annotations

from fastapi.testclient import TestClient

from hermes_management_server.main import Settings, create_app


def make_client(root):
    app = create_app(Settings(hermes_home=str(root)))
    return TestClient(app)


def test_health_and_status(tmp_path):
    root = tmp_path / ".hermes"
    (root / "profiles" / "research").mkdir(parents=True)
    (root / "active_profile").write_text("research", encoding="utf-8")
    client = make_client(root)

    health = client.get("/health")
    status = client.get("/v1/status")

    assert health.status_code == 200
    assert health.json()["profilesRootExists"] is True
    assert status.status_code == 200
    assert status.json()["activeProfile"] == "research"
    assert status.json()["profileCount"] == 2


def test_profile_memory_and_skills_endpoints(tmp_path):
    root = tmp_path / ".hermes"
    profile = root / "profiles" / "research"
    memories = profile / "memories"
    memories.mkdir(parents=True)
    (memories / "MEMORY.md").write_text("remember this", encoding="utf-8")
    (memories / "USER.md").write_text("user facts", encoding="utf-8")
    skill = profile / "skills" / "analysis" / "summarize" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("# Summarize\n\nCondense notes.", encoding="utf-8")
    client = make_client(root)

    profile_response = client.get("/v1/profiles/research")
    memory_response = client.get("/v1/profiles/research/memory")
    skills_response = client.get("/v1/profiles/research/skills")
    skill_id = skills_response.json()["skills"][0]["id"]
    detail_response = client.get(f"/v1/profiles/research/skills/{skill_id}")

    assert profile_response.status_code == 200
    assert profile_response.json()["skillCount"] == 1
    assert memory_response.status_code == 200
    assert memory_response.json()["memory"]["content"] == "remember this"
    assert memory_response.json()["user"]["content"] == "user facts"
    assert skills_response.status_code == 200
    assert skills_response.json()["skills"][0]["name"] == "Summarize"
    assert detail_response.status_code == 200
    assert detail_response.json()["content"] == "# Summarize\n\nCondense notes."


def test_profile_management_endpoints_create_clone_delete(tmp_path):
    root = tmp_path / ".hermes"
    default_memories = root / "memories"
    default_memories.mkdir(parents=True)
    (default_memories / "MEMORY.md").write_text("default memory", encoding="utf-8")
    (root / "profiles" / "existing").mkdir(parents=True)
    client = make_client(root)

    create_response = client.post("/v1/profiles", json={"name": "research"})
    clone_response = client.post("/v1/profiles/default/clone", json={"name": "default-copy"})

    assert create_response.status_code == 200
    assert create_response.json()["profile"] == "research"
    assert (root / "profiles" / "research" / "memories").is_dir()
    assert clone_response.status_code == 200
    assert clone_response.json()["profile"] == "default-copy"
    assert (root / "profiles" / "default-copy" / "memories" / "MEMORY.md").read_text(encoding="utf-8") == "default memory"
    assert not (root / "profiles" / "default-copy" / "profiles").exists()

    delete_response = client.delete("/v1/profiles/research")
    default_delete_response = client.delete("/v1/profiles/default")

    assert delete_response.status_code == 200
    assert not (root / "profiles" / "research").exists()
    assert default_delete_response.status_code == 400
    assert "default profile cannot be deleted" in default_delete_response.json()["error"].lower()


def test_api_returns_structured_error_for_bad_profile(tmp_path):
    client = make_client(tmp_path / ".hermes")

    response = client.get("/v1/profiles/bad$name")

    assert response.status_code == 400
    assert response.json()["ok"] is False
    assert "Profile names" in response.json()["error"]
