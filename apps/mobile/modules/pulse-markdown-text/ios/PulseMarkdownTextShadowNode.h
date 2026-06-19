#pragma once

#include <react/renderer/components/PulseMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/PulseMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char PulseMarkdownTextComponentName[];

struct PulseMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct PulseMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
};

struct PulseMarkdownTextChipRange {
  size_t location;
  size_t length;
  bool isSkill;
};

class PulseMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<PulseMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<PulseMarkdownTextAttachmentRange> attachmentRanges;
  std::vector<PulseMarkdownTextChipRange> chipRanges;
};

class PulseMarkdownTextShadowNode final : public ConcreteViewShadowNode<
PulseMarkdownTextComponentName,
PulseMarkdownTextProps,
PulseMarkdownTextEventEmitter,
PulseMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  PulseMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<PulseMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<PulseMarkdownTextAttachmentRange> _attachmentRanges;
  mutable std::vector<PulseMarkdownTextChipRange> _chipRanges;
};
} // namespace facebook::React
