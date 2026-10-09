// Synthetic native UI for the real CUA observation journey.
#import <AppKit/AppKit.h>
@interface SnapshotDelegate : NSObject <NSApplicationDelegate>
@property(strong) NSWindow *window;
@property(strong) NSTextField *counter;
@property NSInteger count;
@end
@implementation SnapshotDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 440, 220)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"CUA Snapshot Fixture";
    self.window.releasedWhenClosed = NO;
    NSTextField *anchor = [NSTextField labelWithString:@"Stable snapshot anchor"];
    anchor.frame = NSMakeRect(30, 150, 360, 24);
    [self.window.contentView addSubview:anchor];
    self.counter = [NSTextField labelWithString:@"Count: 0"];
    self.counter.frame = NSMakeRect(30, 110, 360, 24);
    [self.window.contentView addSubview:self.counter];
    NSButton *button = [NSButton buttonWithTitle:@"Increment counter" target:self action:@selector(increment:)];
    button.frame = NSMakeRect(30, 50, 200, 36);
    [self.window.contentView addSubview:button];
    [self.window center];
    [self.window makeKeyAndOrderFront:nil];
}
- (void)increment:(id)sender { self.counter.stringValue = [NSString stringWithFormat:@"Count: %ld", (long)++self.count]; }
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)app { return YES; }
@end
int main(void) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        app.activationPolicy = NSApplicationActivationPolicyRegular;
        SnapshotDelegate *delegate = [SnapshotDelegate new];
        app.delegate = delegate;
        [app run];
    }
}
