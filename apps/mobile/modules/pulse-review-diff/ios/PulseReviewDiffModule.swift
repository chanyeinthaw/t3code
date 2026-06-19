import ExpoModulesCore

public class PulseReviewDiffModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PulseReviewDiffSurface")

    View(PulseReviewDiffView.self) {
      Prop("rowsJson") { (view: PulseReviewDiffView, rowsJson: String) in
        view.setRowsJson(rowsJson)
      }

      Prop("tokensJson") { (view: PulseReviewDiffView, tokensJson: String) in
        view.setTokensJson(tokensJson)
      }

      Prop("tokensPatchJson") { (view: PulseReviewDiffView, tokensPatchJson: String) in
        view.setTokensPatchJson(tokensPatchJson)
      }

      Prop("tokensResetKey") { (view: PulseReviewDiffView, tokensResetKey: String) in
        view.setTokensResetKey(tokensResetKey)
      }

      Prop("collapsedFileIdsJson") { (view: PulseReviewDiffView, collapsedFileIdsJson: String) in
        view.setCollapsedFileIdsJson(collapsedFileIdsJson)
      }

      Prop("viewedFileIdsJson") { (view: PulseReviewDiffView, viewedFileIdsJson: String) in
        view.setViewedFileIdsJson(viewedFileIdsJson)
      }

      Prop("selectedRowIdsJson") { (view: PulseReviewDiffView, selectedRowIdsJson: String) in
        view.setSelectedRowIdsJson(selectedRowIdsJson)
      }

      Prop("collapsedCommentIdsJson") { (view: PulseReviewDiffView, collapsedCommentIdsJson: String) in
        view.setCollapsedCommentIdsJson(collapsedCommentIdsJson)
      }

      Prop("appearanceScheme") { (view: PulseReviewDiffView, appearanceScheme: String) in
        view.setAppearanceScheme(appearanceScheme)
      }

      Prop("themeJson") { (view: PulseReviewDiffView, themeJson: String) in
        view.setThemeJson(themeJson)
      }

      Prop("styleJson") { (view: PulseReviewDiffView, styleJson: String) in
        view.setStyleJson(styleJson)
      }

      Prop("rowHeight") { (view: PulseReviewDiffView, rowHeight: Double) in
        view.setRowHeight(CGFloat(rowHeight))
      }

      Prop("contentWidth") { (view: PulseReviewDiffView, contentWidth: Double) in
        view.setContentWidth(CGFloat(contentWidth))
      }

      Events("onDebug", "onToggleFile", "onToggleViewedFile", "onPressLine", "onToggleComment")
    }
  }
}
