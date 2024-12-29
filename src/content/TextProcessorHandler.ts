export class TextProcessorHandler {
    public static removeSpaces(textWithSpace: String | undefined) {
        if (textWithSpace) {
            return textWithSpace.replace(/ /g, '');
        }
        return textWithSpace;
    }
}