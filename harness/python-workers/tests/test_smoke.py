from eval_server import rerank
from rag_server import rag_search


def test_rag_search_returns_ranked_docs():
    docs = rag_search("harness loop", top_k=3)
    assert len(docs) == 3
    assert docs[0]["rank"] == 1


def test_rerank_prefers_overlap():
    out = rerank("ai harness loop", ["ai harness loop explained", "unrelated cooking recipe"])
    assert out[0]["text"].startswith("ai harness")
