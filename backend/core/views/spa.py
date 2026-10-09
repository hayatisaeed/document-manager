from django.conf import settings
from django.http import FileResponse, HttpResponse


def spa_index(request):
    index = settings.FRONTEND_DIST / "index.html"
    if index.exists():
        return FileResponse(open(index, "rb"), content_type="text/html")
    return HttpResponse(
        "<h1>Document Manager API</h1><p>The frontend is not built. Run the Vite dev server "
        "(<code>cd frontend &amp;&amp; npm run dev</code>) and open http://localhost:5173, "
        "or build it with <code>npm run build</code>.</p>",
        content_type="text/html",
    )
