using System.Threading;
using Microsoft.Extensions.Hosting;

// Tiny daemon-shaped target exe so the MSI has a real <File> to install
// and a real ServiceInstall target. Hosting + BackgroundService keeps
// the binary shape similar to a real Windows service host (so size/build
// numbers are not misleading vs. a hello-world that the SCM cannot start).
var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddHostedService<DaemonShape>();
var app = builder.Build();
app.Run();

internal sealed class DaemonShape : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(Timeout.Infinite, ct); }
            catch (TaskCanceledException) { }
        }
    }
}
