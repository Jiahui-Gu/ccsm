// T9.13 spike — minimal Windows Service stub used only to validate that the
// MSI ServiceInstall + ServiceControl elements register, start, and uninstall
// cleanly on Windows 11 25H2. This is NOT shippable code.

using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "CcsmSpikeSvc";
});
builder.Services.AddHostedService<HeartbeatWorker>();
var host = builder.Build();
await host.RunAsync();

internal sealed class HeartbeatWorker(ILogger<HeartbeatWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        log.LogInformation("CcsmSpikeSvc running (pid={Pid})", Environment.ProcessId);
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }
        catch (TaskCanceledException) { /* graceful stop */ }
        log.LogInformation("CcsmSpikeSvc stopping");
    }
}
