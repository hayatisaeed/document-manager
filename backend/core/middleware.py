from django.http import JsonResponse

HEADER = "HTTP_X_DM_CLIENT"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class RequireClientHeaderMiddleware:
    """Reject state-changing API requests that lack the ``X-DM-Client`` header.

    The API has no login (it is a local, single-user app). Browsers only let
    other websites send custom headers after a CORS preflight, which we do not
    grant, so this header stops malicious pages from posting to the local API
    (cross-site request forgery).
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if (request.path.startswith("/api/") and request.method not in SAFE_METHODS
                and request.META.get(HEADER) != "1"):
            return JsonResponse({"detail": "Missing X-DM-Client header."}, status=403)
        return self.get_response(request)
