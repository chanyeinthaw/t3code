#import "PulseMarkdownTextRun.h"
#import "PulseMarkdownText.h"
#import "PulseMarkdownTextRunComponentDescriptor.h"
#import <react/renderer/components/PulseMarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/PulseMarkdownTextSpec/Props.h>
#import <react/renderer/components/PulseMarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"
#import "Utils.h"

using namespace facebook::react;

@interface PulseMarkdownTextRun () <RCTPulseMarkdownTextRunViewProtocol>

@end

@implementation PulseMarkdownTextRun {
  NSString * _text;
  RCTBubblingEventBlock _onPress;
  RCTBubblingEventBlock _onLongPress;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<PulseMarkdownTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const PulseMarkdownTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<PulseMarkdownTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<PulseMarkdownTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::PulseMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::PulseMarkdownTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::PulseMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::PulseMarkdownTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> PulseMarkdownTextRunCls(void)
{
    return PulseMarkdownTextRun.class;
}

@end
