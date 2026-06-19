#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface PulseMarkdownTextManager : RCTViewManager
@end

@implementation PulseMarkdownTextManager

RCT_EXPORT_MODULE(PulseMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface PulseMarkdownTextRunManager : RCTViewManager
@end

@implementation PulseMarkdownTextRunManager

RCT_EXPORT_MODULE(PulseMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
