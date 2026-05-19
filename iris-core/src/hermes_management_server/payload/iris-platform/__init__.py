def register(ctx):
    try:
        from .adapter import register as adapter_register
    except ImportError:
        from adapter import register as adapter_register

    return adapter_register(ctx)

__all__ = ["register"]
