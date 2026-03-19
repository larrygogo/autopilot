"""
基础设施测试：锁机制、通知分发
"""

from core.infra import acquire_lock, is_locked, release_lock


class TestLockMechanism:
    """文件锁测试"""

    def test_acquire_and_release(self):
        """获取锁后释放"""
        fd = acquire_lock("test-lock-001")
        assert fd is not None
        assert is_locked("test-lock-001")
        release_lock("test-lock-001")
        assert not is_locked("test-lock-001")

    def test_double_acquire_returns_none(self):
        """重复获取锁返回 None"""
        fd1 = acquire_lock("test-lock-002")
        assert fd1 is not None
        fd2 = acquire_lock("test-lock-002")
        assert fd2 is None
        release_lock("test-lock-002")

    def test_is_locked_false_when_no_lock(self):
        """未加锁时 is_locked 返回 False"""
        assert not is_locked("test-lock-never")

    def test_release_nonexistent_lock(self):
        """释放不存在的锁不报错"""
        release_lock("test-lock-phantom")
